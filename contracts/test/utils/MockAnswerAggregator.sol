// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAnswerAggregator} from "../../src/shared/oracle/AnswerOnlyFeed.sol";

/// @notice Aggregator with a settable `latestAnswer` and `decimals`, and no `latestRoundData`.
contract MockAnswerAggregator is IAnswerAggregator {
    int256 public latestAnswer;
    uint8 public immutable decimals;

    constructor(int256 answer_, uint8 decimals_) {
        latestAnswer = answer_;
        decimals = decimals_;
    }

    function set(int256 answer_) external {
        latestAnswer = answer_;
    }
}
