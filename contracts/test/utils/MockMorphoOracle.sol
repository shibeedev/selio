// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOracle} from "morpho-blue/interfaces/IOracle.sol";

/// @notice Morpho Blue oracle with a settable price (1e36-scaled).
contract MockMorphoOracle is IOracle {
    uint256 public price;

    constructor(uint256 price_) {
        price = price_;
    }

    function setPrice(uint256 price_) external {
        price = price_;
    }
}
