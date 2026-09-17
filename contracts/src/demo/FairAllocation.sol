// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ArcDrawConsumer} from "../ArcDrawConsumer.sol";
import {IArcDrawCoordinator} from "../interfaces/IArcDrawCoordinator.sol";
import {IERC20Minimal, IERC20Permit} from "../interfaces/IERC20Minimal.sol";
import {SafeUSDC} from "../utils/SafeUSDC.sol";

/// @title FairAllocation
/// @notice Demo ArcDraw consumer: a fair lottery for an oversubscribed USDC allocation (for example an RWA
///         pre-sale or a capped vault). K slots at a fixed price, N subscribers, one slot per address.
///         If N > K, the winners are a uniformly random K-subset chosen from drand randomness via ArcDraw.
///         The treasury receives winners x price; losers pull a full refund. Not a casino: there is no
///         house, no odds, and every subscriber either gets the allocation or their USDC back.
/// @dev Follows the ArcDraw consumer rules: inputs are frozen before the request (subscriptions close at the
///      deadline), the callback only stores the seed, and the shuffle runs in the permissionless `finalize`.
///      Sybil resistance is out of scope (documented limitation).
contract FairAllocation is ArcDrawConsumer {
    using SafeUSDC for IERC20Minimal;

    enum Phase {
        None,
        Open,
        Drawing,
        Drawn,
        Finalized,
        Cancelled // draw never delivered within DRAW_TIMEOUT: every subscriber is refunded
    }

    struct Sale {
        address creator;
        address treasury;
        uint96 pricePerSlot; // USDC, 6 decimals
        uint32 slots; // K
        uint64 subscribeDeadline;
        uint96 bounty; // escrowed from the creator for the ArcDraw fulfiller
        Phase phase;
        uint256 requestId;
        bytes32 seed;
    }

    /// @notice Upper bound on N, so `finalize` stays well under the block gas limit.
    uint32 public constant MAX_PARTICIPANTS = 1000;
    /// @notice Gas forwarded to the callback (it only stores the seed).
    uint32 public constant CALLBACK_GAS = 60_000;
    /// @notice Grace period after the pinned drand round before a never-fulfilled draw can be cancelled.
    uint64 public constant DRAW_TIMEOUT = 7 days;

    IERC20Minimal public immutable usdc;

    uint256 public saleCount;
    mapping(uint256 saleId => Sale) internal _sales;
    mapping(uint256 saleId => address[]) internal _participants;
    /// @dev index + 1 of an account in `_participants[saleId]`; 0 = not subscribed.
    mapping(uint256 saleId => mapping(address account => uint256)) internal _indexPlusOne;
    /// @dev Bitmaps over participant indexes.
    mapping(uint256 saleId => mapping(uint256 word => uint256)) internal _winnerBits;
    mapping(uint256 saleId => mapping(uint256 word => uint256)) internal _refundedBits;
    /// @dev requestId => saleId + 1.
    mapping(uint256 requestId => uint256) internal _saleOfRequest;
    mapping(uint256 saleId => bool) public bountyReclaimed;
    /// @notice USDC credited to the sale treasury at finalize, pulled with `withdrawTreasury`.
    mapping(uint256 saleId => uint256) public treasuryOwed;
    /// @notice Unused bounty escrow credited to the creator at finalize, pulled with `withdrawCreatorBounty`.
    mapping(uint256 saleId => uint96) public creatorOwed;
    /// @notice Where creator payouts (unused or refunded bounty) go; 0 = the creator itself.
    mapping(uint256 saleId => address) public creatorPayee;

    event SaleCreated(
        uint256 indexed saleId,
        address indexed creator,
        address treasury,
        uint96 pricePerSlot,
        uint32 slots,
        uint64 subscribeDeadline
    );
    event Subscribed(uint256 indexed saleId, address indexed account, uint32 index);
    event DrawRequested(uint256 indexed saleId, uint256 indexed requestId, uint64 round);
    event SeedReceived(uint256 indexed saleId, uint256 indexed requestId, bytes32 seed);
    event Finalized(uint256 indexed saleId, uint32 winners, uint256 raised);
    event Refunded(uint256 indexed saleId, address indexed account, uint96 amount);
    event BountyReclaimed(uint256 indexed saleId, address indexed creator, uint96 amount);
    event TreasuryWithdrawn(uint256 indexed saleId, address indexed treasury, uint256 amount);
    event DrawCancelled(uint256 indexed saleId, uint256 indexed requestId);
    event TreasuryUpdated(uint256 indexed saleId, address indexed treasury);
    event CreatorPayeeUpdated(uint256 indexed saleId, address indexed payee);

    error InvalidSaleParams();
    error WrongPhase(uint256 saleId, Phase phase);
    error SubscriptionClosed(uint256 saleId);
    error SubscriptionStillOpen(uint256 saleId, uint64 deadline);
    error AlreadySubscribed(uint256 saleId, address account);
    error SaleFull(uint256 saleId);
    error NotOversubscribed(uint256 saleId);
    error NotEligibleForRefund(uint256 saleId, address account);
    error BountyNotReclaimable(uint256 saleId);
    error NothingOwed(uint256 saleId);
    error RequestNotFulfilled(uint256 saleId, uint256 requestId);
    error DrawNotTimedOut(uint256 saleId, uint64 cancellableAt);
    error NotCreator(uint256 saleId, address caller);

    constructor(IArcDrawCoordinator coordinator_) ArcDrawConsumer(coordinator_) {
        usdc = IERC20Minimal(coordinator_.USDC());
    }

    // ------------------------------------------------------------------ lifecycle

    /// @notice Open a sale. `bounty` (USDC) is pulled from the creator and offered to the ArcDraw fulfiller.
    /// @param treasury Receives winners x pricePerSlot at finalize.
    /// @param pricePerSlot USDC with 6 decimals (1 USDC = 1_000_000).
    /// @param slots Number of allocations K.
    /// @param subscribeDeadline Unix time at which subscriptions close.
    /// @param bounty USDC (6 decimals) for the fulfiller of the draw; 0 relies on voluntary relayers.
    function createSale(address treasury, uint96 pricePerSlot, uint32 slots, uint64 subscribeDeadline, uint96 bounty)
        external
        returns (uint256 saleId)
    {
        if (treasury == address(0) || pricePerSlot == 0 || slots == 0 || subscribeDeadline <= block.timestamp) {
            revert InvalidSaleParams();
        }
        saleId = ++saleCount;
        _sales[saleId] = Sale({
            creator: msg.sender,
            treasury: treasury,
            pricePerSlot: pricePerSlot,
            slots: slots,
            subscribeDeadline: subscribeDeadline,
            bounty: bounty,
            phase: Phase.Open,
            requestId: 0,
            seed: bytes32(0)
        });
        if (bounty > 0) usdc.safeTransferFrom(msg.sender, address(this), bounty);
        emit SaleCreated(saleId, msg.sender, treasury, pricePerSlot, slots, subscribeDeadline);
    }

    /// @notice Subscribe for one slot, paying `pricePerSlot` USDC (requires a prior approve).
    function subscribe(uint256 saleId) external {
        _subscribe(saleId, msg.sender);
    }

    /// @notice Subscribe using an EIP-2612 USDC permit (domain version "2") for `pricePerSlot`.
    /// @dev A failing permit is ignored (it may have been front-run); the transferFrom then decides.
    function subscribeWithPermit(uint256 saleId, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC20Permit(address(usdc))
            .permit(msg.sender, address(this), _sales[saleId].pricePerSlot, deadline, v, r, s) {}
            catch {}
        _subscribe(saleId, msg.sender);
    }

    /// @notice Request randomness for an oversubscribed sale. Permissionless, after the deadline.
    function draw(uint256 saleId) external returns (uint256 requestId) {
        Sale storage sale = _sales[saleId];
        if (sale.phase != Phase.Open) revert WrongPhase(saleId, sale.phase);
        if (block.timestamp < sale.subscribeDeadline) revert SubscriptionStillOpen(saleId, sale.subscribeDeadline);
        if (_participants[saleId].length <= sale.slots) revert NotOversubscribed(saleId);

        sale.phase = Phase.Drawing;
        uint96 bounty = sale.bounty;
        if (bounty > 0) usdc.forceApprove(address(coordinator), bounty);
        uint64 round;
        (requestId, round) = coordinator.requestRandomness(CALLBACK_GAS, bounty);
        sale.requestId = requestId;
        _saleOfRequest[requestId] = saleId + 1;
        emit DrawRequested(saleId, requestId, round);
    }

    /// @notice Settle a sale. Permissionless. After the deadline with N <= K every subscriber wins and no
    ///         randomness is needed; otherwise requires the drawn seed. Credits the treasury winners x price.
    /// @dev Never transfers: payouts are pulled separately, so a blocklisted treasury or creator can never
    ///      block finalization (and with it every loser's refund).
    function finalize(uint256 saleId) external {
        Sale storage sale = _sales[saleId];
        Phase phase = sale.phase;
        uint256 n = _participants[saleId].length;
        uint32 winners;

        if (phase == Phase.Open) {
            if (block.timestamp < sale.subscribeDeadline) revert SubscriptionStillOpen(saleId, sale.subscribeDeadline);
            if (n > sale.slots) revert WrongPhase(saleId, phase); // must draw first
            // casting to uint32 is safe because n <= MAX_PARTICIPANTS
            // forge-lint: disable-next-line(unsafe-typecast)
            winners = uint32(n);
            // No draw happened: credit the unused bounty escrow to the creator.
            uint96 bounty = sale.bounty;
            if (bounty > 0) {
                sale.bounty = 0;
                bountyReclaimed[saleId] = true;
                creatorOwed[saleId] = bounty;
            }
        } else if (phase == Phase.Drawn) {
            winners = sale.slots;
            _selectWinners(saleId, sale.seed, n, winners);
        } else {
            revert WrongPhase(saleId, phase);
        }

        sale.phase = Phase.Finalized;
        uint256 raised = uint256(winners) * sale.pricePerSlot;
        treasuryOwed[saleId] = raised;
        emit Finalized(saleId, winners, raised);
    }

    /// @notice Pay the finalized proceeds to the sale treasury. Permissionless; the recipient is `sale.treasury`.
    function withdrawTreasury(uint256 saleId) external {
        uint256 amount = treasuryOwed[saleId];
        if (amount == 0) revert NothingOwed(saleId);
        treasuryOwed[saleId] = 0;
        address treasury = _sales[saleId].treasury;
        usdc.safeTransfer(treasury, amount);
        emit TreasuryWithdrawn(saleId, treasury, amount);
    }

    /// @notice Return the unused bounty escrow of an undrawn sale to its creator (or `creatorPayee`). Permissionless.
    function withdrawCreatorBounty(uint256 saleId) external {
        uint96 amount = creatorOwed[saleId];
        if (amount == 0) revert NothingOwed(saleId);
        creatorOwed[saleId] = 0;
        address payee = _creatorPayout(saleId);
        usdc.safeTransfer(payee, amount);
        emit BountyReclaimed(saleId, payee, amount);
    }

    /// @notice Creator only: move the sale proceeds to another treasury, for example when the current one is
    ///         blocklisted by USDC (which would otherwise lock `treasuryOwed` forever). Any phase.
    /// @dev Subscribers are unaffected: refunds never depend on the treasury.
    function setTreasury(uint256 saleId, address newTreasury) external {
        Sale storage sale = _onlyCreator(saleId);
        if (newTreasury == address(0)) revert InvalidSaleParams();
        sale.treasury = newTreasury;
        emit TreasuryUpdated(saleId, newTreasury);
    }

    /// @notice Creator only: send creator payouts (`withdrawCreatorBounty`, `reclaimBounty`) to `payee` instead of
    ///         the creator address, for example when the creator is blocklisted by USDC.
    function setCreatorPayee(uint256 saleId, address payee) external {
        _onlyCreator(saleId);
        if (payee == address(0)) revert InvalidSaleParams();
        creatorPayee[saleId] = payee;
        emit CreatorPayeeUpdated(saleId, payee);
    }

    /// @notice Recover a draw whose ArcDraw callback did not land (for example it ran out of gas): copy the
    ///         randomness the coordinator already stored. Permissionless; the outcome is identical to the
    ///         callback's, so it cannot be ground.
    function syncSeed(uint256 saleId) external {
        Sale storage sale = _sales[saleId];
        if (sale.phase != Phase.Drawing) revert WrongPhase(saleId, sale.phase);
        uint256 requestId = sale.requestId;
        IArcDrawCoordinator.Request memory r = coordinator.getRequest(requestId);
        if (r.status != IArcDrawCoordinator.Status.Fulfilled) revert RequestNotFulfilled(saleId, requestId);
        sale.seed = r.randomness;
        sale.phase = Phase.Drawn;
        emit SeedReceived(saleId, requestId, r.randomness);
    }

    /// @notice Escape hatch: if the draw is still unfulfilled DRAW_TIMEOUT after its drand round was due, cancel
    ///         the sale so every subscriber can pull a full refund. Permissionless.
    /// @dev Anyone can fulfill with drand's public signature during those 7 days, so a single party cannot force
    ///      a cancellation over an outcome others want delivered.
    function cancelStuckDraw(uint256 saleId) external {
        Sale storage sale = _sales[saleId];
        if (sale.phase != Phase.Drawing) revert WrongPhase(saleId, sale.phase);
        uint256 requestId = sale.requestId;
        IArcDrawCoordinator.Request memory r = coordinator.getRequest(requestId);
        if (r.status == IArcDrawCoordinator.Status.Fulfilled) revert WrongPhase(saleId, sale.phase); // use syncSeed
        uint64 cancellableAt = coordinator.roundTimestamp(r.round) + DRAW_TIMEOUT;
        if (block.timestamp < cancellableAt) revert DrawNotTimedOut(saleId, cancellableAt);
        sale.phase = Phase.Cancelled;
        emit DrawCancelled(saleId, requestId);
    }

    /// @notice Losers pull back their full subscription after finalize; in a cancelled sale everyone does.
    function claimRefund(uint256 saleId) external {
        Sale storage sale = _sales[saleId];
        Phase phase = sale.phase;
        if (phase != Phase.Finalized && phase != Phase.Cancelled) revert WrongPhase(saleId, phase);
        uint256 idxPlusOne = _indexPlusOne[saleId][msg.sender];
        if (idxPlusOne == 0) revert NotEligibleForRefund(saleId, msg.sender);
        uint256 idx = idxPlusOne - 1;
        if ((phase == Phase.Finalized && _isWinnerIdx(saleId, sale, idx)) || _bit(_refundedBits[saleId], idx)) {
            revert NotEligibleForRefund(saleId, msg.sender);
        }
        _refundedBits[saleId][idx >> 8] |= uint256(1) << (idx & 0xff);
        uint96 amount = sale.pricePerSlot;
        usdc.safeTransfer(msg.sender, amount);
        emit Refunded(saleId, msg.sender, amount);
    }

    /// @notice If ArcDraw refunded the draw's bounty (request expired before fulfillment), forward it to the
    ///         sale creator (or `creatorPayee`). The draw itself stays fulfillable, so this never affects the outcome.
    /// @dev Keyed on `coordinator.refundedBounty`, which survives a late fulfillment, so the call can be made
    ///      before or after the draw completes.
    function reclaimBounty(uint256 saleId) external {
        Sale storage sale = _sales[saleId];
        uint256 requestId = sale.requestId;
        if (requestId == 0 || bountyReclaimed[saleId]) revert BountyNotReclaimable(saleId);
        uint96 bounty = coordinator.refundedBounty(requestId);
        if (bounty == 0) revert BountyNotReclaimable(saleId);
        bountyReclaimed[saleId] = true;
        address payee = _creatorPayout(saleId);
        usdc.safeTransfer(payee, bounty);
        emit BountyReclaimed(saleId, payee, bounty);
    }

    // ------------------------------------------------------------------ views

    /// @notice Sale parameters and state.
    function getSale(uint256 saleId) external view returns (Sale memory) {
        return _sales[saleId];
    }

    /// @notice True once finalized and `account` received an allocation.
    function isWinner(uint256 saleId, address account) external view returns (bool) {
        Sale storage sale = _sales[saleId];
        uint256 idxPlusOne = _indexPlusOne[saleId][account];
        if (sale.phase != Phase.Finalized || idxPlusOne == 0) return false;
        return _isWinnerIdx(saleId, sale, idxPlusOne - 1);
    }

    /// @notice True if `account` already pulled its refund.
    function hasRefunded(uint256 saleId, address account) external view returns (bool) {
        uint256 idxPlusOne = _indexPlusOne[saleId][account];
        return idxPlusOne != 0 && _bit(_refundedBits[saleId], idxPlusOne - 1);
    }

    /// @notice All subscribers in subscription order.
    function participants(uint256 saleId) external view returns (address[] memory) {
        return _participants[saleId];
    }

    /// @notice Number of subscribers N.
    function participantCount(uint256 saleId) external view returns (uint256) {
        return _participants[saleId].length;
    }

    /// @notice Sale id for an ArcDraw request id (0 if unknown).
    function saleOfRequest(uint256 requestId) external view returns (uint256) {
        uint256 s = _saleOfRequest[requestId];
        return s == 0 ? 0 : s - 1;
    }

    // ------------------------------------------------------------------ internals

    function _onlyCreator(uint256 saleId) internal view returns (Sale storage sale) {
        sale = _sales[saleId];
        if (sale.phase == Phase.None || msg.sender != sale.creator) revert NotCreator(saleId, msg.sender);
    }

    function _creatorPayout(uint256 saleId) internal view returns (address) {
        address payee = creatorPayee[saleId];
        return payee == address(0) ? _sales[saleId].creator : payee;
    }

    function _subscribe(uint256 saleId, address account) internal {
        Sale storage sale = _sales[saleId];
        if (sale.phase != Phase.Open) revert WrongPhase(saleId, sale.phase);
        if (block.timestamp >= sale.subscribeDeadline) revert SubscriptionClosed(saleId);
        if (_indexPlusOne[saleId][account] != 0) revert AlreadySubscribed(saleId, account);
        address[] storage list = _participants[saleId];
        if (list.length >= MAX_PARTICIPANTS) revert SaleFull(saleId);
        uint32 index = uint32(list.length);
        list.push(account);
        _indexPlusOne[saleId][account] = uint256(index) + 1;
        usdc.safeTransferFrom(account, address(this), sale.pricePerSlot);
        emit Subscribed(saleId, account, index);
    }

    /// @dev ArcDraw callback: store the seed only. Unknown or stale request ids are ignored.
    function _fulfillRandomness(uint256 requestId, bytes32 randomness) internal override {
        uint256 s = _saleOfRequest[requestId];
        if (s == 0) return;
        uint256 saleId = s - 1;
        Sale storage sale = _sales[saleId];
        if (sale.phase != Phase.Drawing || sale.requestId != requestId) return;
        sale.seed = randomness;
        sale.phase = Phase.Drawn;
        emit SeedReceived(saleId, requestId, randomness);
    }

    function _selectWinners(uint256 saleId, bytes32 seed, uint256 n, uint256 k) internal {
        uint256[4] memory bits = _winnerBitmap(seed, n, k);
        mapping(uint256 => uint256) storage winnerBits = _winnerBits[saleId];
        for (uint256 wd; wd < 4; ++wd) {
            if (bits[wd] != 0) winnerBits[wd] = bits[wd];
        }
    }

    /// @dev Partial Fisher-Yates over participant indexes: the first k positions form a uniform k-subset.
    ///      Modulo bias is below 2^-246 for n <= 1000. Requires k < n <= MAX_PARTICIPANTS.
    function _winnerBitmap(bytes32 seed, uint256 n, uint256 k) internal pure returns (uint256[4] memory bits) {
        uint256[] memory idx = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            idx[i] = i;
        }
        for (uint256 i; i < k; ++i) {
            uint256 j = i + uint256(keccak256(abi.encode(seed, i))) % (n - i);
            (idx[i], idx[j]) = (idx[j], idx[i]);
            uint256 w = idx[i];
            bits[w >> 8] |= uint256(1) << (w & 0xff);
        }
    }

    function _isWinnerIdx(uint256 saleId, Sale storage sale, uint256 idx) internal view returns (bool) {
        if (_participants[saleId].length <= sale.slots) return true; // no draw: everyone wins
        return _bit(_winnerBits[saleId], idx);
    }

    function _bit(mapping(uint256 => uint256) storage bits, uint256 idx) internal view returns (bool) {
        return bits[idx >> 8] & (uint256(1) << (idx & 0xff)) != 0;
    }
}
