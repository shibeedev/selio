// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceFeed} from "../interfaces/IPriceFeed.sol";

/// @notice Aggregator that exposes its answer but no working `latestRoundData`.
interface IAnswerAggregator {
    function latestAnswer() external view returns (int256);
    function decimals() external view returns (uint8);
}

/// @notice Chainlink-compatible view of an aggregator that has only `latestAnswer()` and `decimals()`
/// (the "USDT0 / USD (USD Scaled)" aggregator on Monad).
/// @dev The aggregator exposes no update time, so `updatedAt` is the current block and staleness is not detectable.
contract AnswerOnlyFeed is IPriceFeed {
    IAnswerAggregator public immutable aggregator;

    constructor(IAnswerAggregator aggregator_) {
        aggregator = aggregator_;
    }

    function decimals() external view returns (uint8) {
        return aggregator.decimals();
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        int256 answer = aggregator.latestAnswer();
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
