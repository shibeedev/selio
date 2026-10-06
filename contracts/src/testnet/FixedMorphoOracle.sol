// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOracle} from "morpho-blue/interfaces/IOracle.sol";

/// @notice Morpho Blue oracle with a constant price, for testnets without price feeds.
/// @dev `price` is the value of one collateral unit in loan units, scaled by 1e36.
contract FixedMorphoOracle is IOracle {
    uint256 public immutable price;

    constructor(uint256 price_) {
        require(price_ > 0, "price");
        price = price_;
    }
}
