// Generated from contracts/out by scripts/export-abis.mjs. Do not edit.
export const kuruSellRouterAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "market_",
        "type": "address",
        "internalType": "contract ExitMarket"
      },
      {
        "name": "book_",
        "type": "address",
        "internalType": "contract IKuruOrderBook"
      },
      {
        "name": "wrapper_",
        "type": "address",
        "internalType": "contract IStataToken"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "base",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "book",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IKuruOrderBook"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "exitCapacity",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct ExitMarket.Capacity",
        "components": [
          {
            "name": "withdrawable",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "supplied",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "utilizationBps",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "debtorCapacity",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "sessionAssets",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "facePerBase",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "market",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract ExitMarket"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quote",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "receipt",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "sell",
    "inputs": [
      {
        "name": "o",
        "type": "tuple",
        "internalType": "struct KuruSellRouter.SellOrder",
        "components": [
          {
            "name": "selioAssets",
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
            "name": "payMask",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "selioMinFilled",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "kuruAssets",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "kuruMinOut",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "to",
            "type": "address",
            "internalType": "address"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "selioFilled",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "selioPaid",
        "type": "uint256[]",
        "internalType": "uint256[]"
      },
      {
        "name": "kuruOut",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "wrapper",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IStataToken"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "KuruRoutedSale",
    "inputs": [
      {
        "name": "seller",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "selioAssets",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "selioFilled",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "kuruAssets",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "kuruBase",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "kuruOut",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BadParams",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeCastOverflowedUintDowncast",
    "inputs": [
      {
        "name": "bits",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
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
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;
