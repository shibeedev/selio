// Generated from contracts/out by scripts/export-abis.mjs. Do not edit.
export const aaveCollateralRouteAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "pool_",
        "type": "address",
        "internalType": "contract IAavePool"
      },
      {
        "name": "markets_",
        "type": "address[]",
        "internalType": "contract AaveExitMarket[]"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "executeOperation",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "premium",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "initiator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "isMarket",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pool",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IAavePool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "repayWithFrozenCollateral",
    "inputs": [
      {
        "name": "market",
        "type": "address",
        "internalType": "contract AaveExitMarket"
      },
      {
        "name": "collateralAmount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "bidIds",
        "type": "uint256[]",
        "internalType": "uint256[]"
      },
      {
        "name": "maxDiscountBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "payIdx",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "repayAmount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "minProceeds",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "sold",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "swapFrozenCollateral",
    "inputs": [
      {
        "name": "market",
        "type": "address",
        "internalType": "contract AaveExitMarket"
      },
      {
        "name": "collateralAmount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "bidIds",
        "type": "uint256[]",
        "internalType": "uint256[]"
      },
      {
        "name": "maxDiscountBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "payIdx",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "minProceeds",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "sold",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "supplied",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "CollateralSoldForRepay",
    "inputs": [
      {
        "name": "user",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "market",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "collateralSold",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "debtAsset",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "repaid",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CollateralSwapped",
    "inputs": [
      {
        "name": "user",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "market",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "collateralSold",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "newCollateral",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "supplied",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "ProceedsTooLow",
    "inputs": [
      {
        "name": "proceeds",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "needed",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "UnexpectedCallback",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownMarket",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;
