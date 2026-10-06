// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceFeed} from "../interfaces/IPriceFeed.sol";

/// @notice Price feed that always reports the same USD price, refreshed every block.
/// @dev Used only for testnet tokens that have no market price (the monad-testnet USDC and AUSD-sim at $1).
contract FixedPriceFeed is IPriceFeed {
    int256 public immutable price;
    uint8 public immutable decimals;

    constructor(int256 price_, uint8 decimals_) {
        require(price_ > 0, "price");
        price = price_;
        decimals = decimals_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, price, block.timestamp, block.timestamp, 1);
    }
}
