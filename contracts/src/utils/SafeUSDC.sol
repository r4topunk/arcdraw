// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20Minimal} from "../interfaces/IERC20Minimal.sol";

/// @notice Minimal SafeERC20-style helpers: bubble reverts (for example a USDC blocklist revert)
///         and treat a `false` return or a missing contract as failure.
library SafeUSDC {
    error TokenTransferFailed(address token);

    function safeTransfer(IERC20Minimal token, address to, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
    }

    function safeTransferFrom(IERC20Minimal token, address from, address to, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
    }

    function forceApprove(IERC20Minimal token, address spender, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20Minimal.approve, (spender, amount)));
    }

    function _call(IERC20Minimal token, bytes memory data) private {
        (bool ok, bytes memory ret) = address(token).call(data);
        if (!ok) {
            // Bubble the token's own revert reason (for example "Blacklistable: account is blacklisted").
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        if (ret.length == 0) {
            if (address(token).code.length == 0) revert TokenTransferFailed(address(token));
        } else if (ret.length < 32 || abi.decode(ret, (uint256)) != 1) {
            revert TokenTransferFailed(address(token));
        }
    }
}
