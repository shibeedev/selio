// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Freely mintable token for testnet scenarios (for example simulated collateral).
/// @dev Testnet only. Anyone can mint up to `MINT_LIMIT` per call so demo users can fund themselves.
contract TestToken is ERC20 {
    uint8 private immutable decimals_;
    uint256 public immutable MINT_LIMIT;

    error MintLimit();

    constructor(string memory name_, string memory symbol_, uint8 decimalsValue, uint256 mintLimit)
        ERC20(name_, symbol_)
    {
        decimals_ = decimalsValue;
        MINT_LIMIT = mintLimit;
    }

    function decimals() public view override returns (uint8) {
        return decimals_;
    }

    function mint(address to, uint256 amount) external {
        if (amount > MINT_LIMIT) revert MintLimit();
        _mint(to, amount);
    }
}
