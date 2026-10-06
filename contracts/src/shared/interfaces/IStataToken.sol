// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal subset of an Aave static (non-rebasing) aToken wrapper, an ERC-4626 vault over the reserve's
/// underlying whose shares wrap and unwrap the reserve's aToken without touching the pool's cash.
interface IStataToken {
    function depositATokens(uint256 assets, address receiver) external returns (uint256 shares);
    function redeemATokens(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
    function previewDeposit(uint256 assets) external view returns (uint256);
    function aToken() external view returns (address);
    function asset() external view returns (address);
    function decimals() external view returns (uint8);
    function paused() external view returns (bool);
}
