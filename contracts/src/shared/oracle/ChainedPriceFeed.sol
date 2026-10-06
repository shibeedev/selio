// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceFeed} from "../interfaces/IPriceFeed.sol";

/// @notice USD price of an asset quoted in another asset, e.g. wstETH/ETH x ETH/USD = wstETH/USD.
/// @dev Reports 8 decimals and the older of the two update times, so staleness checks see the weakest leg.
contract ChainedPriceFeed is IPriceFeed {
    IPriceFeed public immutable base;
    IPriceFeed public immutable quote;
    uint8 public constant decimals = 8;

    constructor(IPriceFeed base_, IPriceFeed quote_) {
        base = base_;
        quote = quote_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        (, int256 a,, uint256 ua,) = base.latestRoundData();
        (, int256 b,, uint256 ub,) = quote.latestRoundData();
        if (a <= 0 || b <= 0) return (0, 0, 0, 0, 0);
        uint256 price = uint256(a) * uint256(b) * 1e8 / (10 ** base.decimals() * 10 ** quote.decimals());
        uint256 updated = ua < ub ? ua : ub;
        return (1, int256(price), updated, updated, 1);
    }
}
