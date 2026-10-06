// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Liquidity of the pool behind a Selio Vault's yield source.
interface ISourceProbe {
    /// @notice What the pool can pay out now and what is supplied to it, in the pool's asset.
    function liquidity() external view returns (uint256 withdrawable, uint256 supplied);

    /// @notice Receipt token of the measured pool (an aToken or a vault share).
    function receipt() external view returns (address);
}
