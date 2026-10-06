// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {IMorpho, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {VaultV2} from "vault-v2/VaultV2.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MorphoMarketV1AdapterV2} from "vault-v2/adapters/MorphoMarketV1AdapterV2.sol";

/// @notice Deploys a Morpho Blue + Vault V2 stack shaped like a USDC Earn vault.
/// @dev Shared by the Monad testnet deployment and the local test suite. The caller (test contract or broadcasting
/// deployer) becomes Morpho owner, vault owner, curator and allocator; all timelocks are zero.
abstract contract MorphoStack is CommonBase {
    uint256 internal constant EARN_LLTV = 0.86e18;
    uint256 internal constant FLASH_LLTV = 0.77e18;
    /// @dev LLTV of the yield vault's own market, so it is a market distinct from the earn and flash markets.
    uint256 internal constant YIELD_LLTV = 0.915e18;
    uint256 internal constant MAX_RATE = 200e16 / uint256(365 days);

    struct Stack {
        IMorpho morpho;
        address irm;
        IVaultV2 vault;
        address adapter;
        /// Market the vault supplies to; borrowers here are the exit buyers.
        MarketParams earnMarket;
        /// Separate market whose idle loan tokens give Morpho free flash-loan liquidity.
        MarketParams flashMarket;
    }

    function _create(string memory artifact, bytes memory args) internal returns (address deployed) {
        bytes memory code = abi.encodePacked(vm.getCode(artifact), args);
        assembly {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        require(deployed != address(0), artifact);
    }

    function _buildMorphoStack(
        address admin,
        address loanToken,
        address collateralToken,
        address oracle,
        string memory vaultName,
        string memory vaultSymbol
    ) internal returns (Stack memory s) {
        s.morpho = IMorpho(_create("out/Morpho.sol/Morpho.json", abi.encode(admin)));
        s.irm = _create("out/AdaptiveCurveIrm.sol/AdaptiveCurveIrm.json", abi.encode(address(s.morpho)));
        s.morpho.enableIrm(s.irm);
        s.morpho.enableLltv(EARN_LLTV);
        s.morpho.enableLltv(FLASH_LLTV);
        s.earnMarket = MarketParams(loanToken, collateralToken, oracle, s.irm, EARN_LLTV);
        s.flashMarket = MarketParams(loanToken, collateralToken, oracle, s.irm, FLASH_LLTV);
        s.morpho.createMarket(s.earnMarket);
        s.morpho.createMarket(s.flashMarket);
        (s.vault, s.adapter) = _buildVault(admin, s.morpho, s.irm, s.earnMarket, vaultName, vaultSymbol);
    }

    /// @dev A second Vault V2 of the same loan token on its own market (LLTV `YIELD_LLTV`), with a liquidity adapter on
    /// that market: the Selio Vault's base-yield source on Monad testnet.
    function _buildYieldVault(
        Stack memory s,
        address admin,
        string memory vaultName,
        string memory vaultSymbol
    ) internal returns (IVaultV2 vault, address adapter, MarketParams memory market) {
        s.morpho.enableLltv(YIELD_LLTV);
        market = MarketParams(
            s.earnMarket.loanToken, s.earnMarket.collateralToken, s.earnMarket.oracle, s.irm, YIELD_LLTV
        );
        s.morpho.createMarket(market);
        (vault, adapter) = _buildVault(admin, s.morpho, s.irm, market, vaultName, vaultSymbol);
    }

    /// @dev Vault V2 with one `MorphoMarketV1AdapterV2`, full caps on `market` and that market as liquidity market.
    function _buildVault(
        address admin,
        IMorpho morpho,
        address irm,
        MarketParams memory market,
        string memory vaultName,
        string memory vaultSymbol
    ) internal returns (IVaultV2 vault, address adapter) {
        VaultV2 v = new VaultV2(admin, market.loanToken);
        vault = IVaultV2(address(v));
        vault.setName(vaultName);
        vault.setSymbol(vaultSymbol);
        vault.setCurator(admin);
        _timelocked(vault, abi.encodeCall(IVaultV2.setIsAllocator, (admin, true)));
        adapter = address(new MorphoMarketV1AdapterV2(address(v), address(morpho), irm));
        _timelocked(vault, abi.encodeCall(IVaultV2.addAdapter, (adapter)));
        _cap(vault, abi.encode("this", adapter));
        _cap(vault, abi.encode("collateralToken", market.collateralToken));
        _cap(vault, abi.encode("this/marketParams", adapter, market));
        vault.setLiquidityAdapterAndData(adapter, abi.encode(market));
        vault.setMaxRate(MAX_RATE);
    }

    function _timelocked(IVaultV2 vault, bytes memory call) internal {
        vault.submit(call);
        (bool ok, bytes memory ret) = address(vault).call(call);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function _cap(IVaultV2 vault, bytes memory idData) internal {
        _timelocked(vault, abi.encodeCall(IVaultV2.increaseAbsoluteCap, (idData, type(uint128).max)));
        _timelocked(vault, abi.encodeCall(IVaultV2.increaseRelativeCap, (idData, 1e18)));
    }
}
