// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Deploy} from "../../script/Deploy.s.sol";
import {IKuruOrderBook, IKuruRouter} from "../../src/shared/interfaces/IKuru.sol";

/// @notice The deployment script's Kuru market creation (create, or reuse when it exists), exposed for the tests.
contract KuruDeployHarness is Deploy {
    function kuruMarket(IKuruRouter router, address base, address quote) external returns (IKuruOrderBook) {
        return _kuruMarket(router, base, quote);
    }
}
