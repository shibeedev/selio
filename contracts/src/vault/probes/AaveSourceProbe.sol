// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAavePool} from "../../shared/interfaces/IAaveV3.sol";
import {ISourceProbe} from "../../shared/interfaces/ISourceProbe.sol";

/// @notice Liquidity of one Aave V3 reserve, for a yield source that supplies it (for example a static aToken).
/// @dev Withdrawable is Aave's virtual balance, which underlying sent to the aToken directly does not raise.
contract AaveSourceProbe is ISourceProbe {
    IAavePool public immutable pool;
    address public immutable asset;
    IERC20 public immutable aToken;

    constructor(IAavePool pool_, address asset_, address aToken_) {
        pool = pool_;
        asset = asset_;
        aToken = IERC20(aToken_);
    }

    function liquidity() external view returns (uint256 withdrawable, uint256 supplied) {
        withdrawable = pool.getVirtualUnderlyingBalance(asset);
        supplied = aToken.totalSupply();
    }

    function receipt() external view returns (address) {
        return address(aToken);
    }
}
