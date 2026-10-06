// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {IMorphoMarketV1AdapterV2} from "vault-v2/adapters/interfaces/IMorphoMarketV1AdapterV2.sol";
import {ISourceProbe} from "../../shared/interfaces/ISourceProbe.sol";

/// @notice Liquidity of a Morpho Vault V2 used as a yield source.
/// @dev Withdrawable = the vault's idle asset plus, for its liquidity adapter's market (a `MorphoMarketV1AdapterV2`),
/// the smaller of the vault's position and the market's free liquidity; supplied = the vault's total assets.
contract MorphoVaultSourceProbe is ISourceProbe {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    IVaultV2 public immutable vault;

    constructor(IVaultV2 vault_) {
        vault = vault_;
    }

    function liquidity() external view returns (uint256 withdrawable, uint256 supplied) {
        withdrawable = IERC20(vault.asset()).balanceOf(address(vault));
        address liquidityAdapter = vault.liquidityAdapter();
        if (liquidityAdapter != address(0)) {
            IMorphoMarketV1AdapterV2 a = IMorphoMarketV1AdapterV2(liquidityAdapter);
            MarketParams memory mp = abi.decode(vault.liquidityData(), (MarketParams));
            (uint256 marketSupply,, uint256 marketBorrow,) = IMorpho(a.morpho()).expectedMarketBalances(mp);
            uint256 position = a.expectedSupplyAssets(Id.unwrap(mp.id()));
            uint256 free = marketSupply - marketBorrow;
            withdrawable += position < free ? position : free;
        }
        supplied = vault.totalAssets();
    }

    function receipt() external view returns (address) {
        return address(vault);
    }
}
