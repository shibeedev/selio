// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceFeed} from "../../src/shared/interfaces/IPriceFeed.sol";

/// @notice Chainlink-style feed with a settable answer and update time.
contract MockPriceFeed is IPriceFeed {
    int256 public answer;
    uint256 public updatedAt;
    uint8 public immutable decimals;

    constructor(int256 answer_, uint8 decimals_) {
        decimals = decimals_;
        set(answer_);
    }

    function set(int256 answer_) public {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
