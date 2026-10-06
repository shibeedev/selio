// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// Forces compilation of Morpho Blue and the AdaptiveCurveIrm so scripts and tests can deploy them by artifact.
import {Morpho} from "morpho-blue/Morpho.sol";
import {AdaptiveCurveIrm} from "morpho-blue-irm/adaptive-curve-irm/AdaptiveCurveIrm.sol";
