// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice The subset of ERC-20 (plus EIP-2612 permit) that ArcDraw uses on Arc's USDC
///         (0x3600000000000000000000000000000000000000, 6 decimals).
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}
