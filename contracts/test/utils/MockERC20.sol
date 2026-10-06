// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC-20 with configurable decimals and unrestricted `mint`.
contract MockERC20 is ERC20 {
    uint8 private immutable decimals_;

    constructor(string memory name_, string memory symbol_, uint8 decimalsValue) ERC20(name_, symbol_) {
        decimals_ = decimalsValue;
    }

    function decimals() public view override returns (uint8) {
        return decimals_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
