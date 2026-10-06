// Generated from contracts/out by scripts/export-abis.mjs. Do not edit.
export const aaveExitMarketAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "pool_",
        "type": "address",
        "internalType": "contract IAavePool"
      },
      {
        "name": "aToken_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "debtToken_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "prices_",
        "type": "address",
        "internalType": "contract PriceRouter"
      },
      {
        "name": "payTokens_",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "payATokens_",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "externalFlash_",
        "type": "address",
        "internalType": "contract IMorpho"
      },
      {
        "name": "minEscrows_",
        "type": "uint256[]",
        "internalType": "uint256[]"
      },
      {
        "name": "feeRecipient_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "FEE_BPS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_DISCOUNT_BPS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_LOOPS",
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
    "name": "MAX_PAY_TOKENS",
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
    "name": "MAX_SESSION_DURATION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "activeBidCount",
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
    "name": "activeBidIds",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "activeBidIdsPage",
    "inputs": [
      {
        "name": "offset",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "limit",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "ids",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "assetsFor",
    "inputs": [
      {
        "name": "payAmount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "discountBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "payToken",
        "type": "address",
        "internalType": "address"
      }
    ],
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
    "name": "bidCapacity",
    "inputs": [
      {
        "name": "bidId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "discountBps",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
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
    "name": "bidCapacityAt",
    "inputs": [
      {
        "name": "discountBps",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "outputs": [
      {
        "name": "total",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "bidCapacityAtPage",
    "inputs": [
      {
        "name": "discountBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "offset",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "limit",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "total",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "bids",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "bidder",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "minDiscountBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "payIdx",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "maxAssets",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "escrow",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "buyAndRepay",
    "inputs": [
      {
        "name": "sessionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "payIdx",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "maxPay",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "venueData",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "paid",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "debtRepaid",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "buyAndRepayWithCollateral",
    "inputs": [
      {
        "name": "sessionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "payIdx",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "maxPay",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "venueData",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "paid",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "debtRepaid",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelBid",
    "inputs": [
      {
        "name": "bidId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "refunded",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "capacity",
    "inputs": [],
    "outputs": [
      {
        "name": "c",
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
    "name": "collateralATokenOf",
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
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "collateralPullMargin",
    "inputs": [
      {
        "name": "payToken",
        "type": "address",
        "internalType": "address"
      }
    ],
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
    "name": "debtToken",
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
    "name": "discountOf",
    "inputs": [
      {
        "name": "sessionId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
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
        "name": "chunk",
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
    "name": "externalFlash",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IMorpho"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feeOf",
    "inputs": [
      {
        "name": "payment",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "feeRecipient",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "fillsOf",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "units",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "paid",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "flashCapacity",
    "inputs": [],
    "outputs": [
      {
        "name": "aaveChunk",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "externalChunk",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isOpen",
    "inputs": [
      {
        "name": "sessionId",
        "type": "uint256",
        "internalType": "uint256"
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
    "name": "matchBid",
    "inputs": [
      {
        "name": "sessionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "bidId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "filled",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "paid",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "minEscrowOf",
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
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nextBidId",
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
    "name": "nextSessionId",
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
    "name": "onMorphoFlashLoan",
    "inputs": [
      {
        "name": "chunk",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "openSession",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct ExitMarket.SessionParams",
        "components": [
          {
            "name": "startBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "stepBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "stepInterval",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "capBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "duration",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "payMask",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "sessionId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "payTokens",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "placeBid",
    "inputs": [
      {
        "name": "minDiscountBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "payIdx",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "maxAssets",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "escrow",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "bidId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
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
    "name": "prices",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract PriceRouter"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quote",
    "inputs": [
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "discountBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "payToken",
        "type": "address",
        "internalType": "address"
      }
    ],
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
    "name": "receiptValue",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "redeemReceipt",
    "inputs": [
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "redeemed",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "remainingAssets",
    "inputs": [
      {
        "name": "sessionId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
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
    "name": "resizeBid",
    "inputs": [
      {
        "name": "bidId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxAssets",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "escrow",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "sellNow",
    "inputs": [
      {
        "name": "assets",
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
        "name": "minFilled",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "filled",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "paid",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "sessions",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "seller",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "startedAt",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "endsAt",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "startBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "stepBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "capBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "payMask",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "stepInterval",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "units",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalEscrow",
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
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalSessionUnits",
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
    "name": "underlying",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "unitsOf",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
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
    "name": "unitsToAssets",
    "inputs": [
      {
        "name": "units",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
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
    "name": "withdrawUnsold",
    "inputs": [
      {
        "name": "sessionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "units",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "BidCancelled",
    "inputs": [
      {
        "name": "bidId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "bidder",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "refunded",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BidFilled",
    "inputs": [
      {
        "name": "bidId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "sessionId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "seller",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "assets",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "paid",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "fee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "discountBps",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BidPlaced",
    "inputs": [
      {
        "name": "bidId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "bidder",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "minDiscountBps",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "payToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "maxAssets",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "escrow",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BidResized",
    "inputs": [
      {
        "name": "bidId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "bidder",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "maxAssets",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "escrow",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Bought",
    "inputs": [
      {
        "name": "sessionId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "buyer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "assets",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "debtRepaid",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "discountBps",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "payToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "paid",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "fee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "mode",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum ExitMarket.PayMode"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ReceiptRedeemed",
    "inputs": [
      {
        "name": "holder",
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
        "name": "assets",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SessionOpened",
    "inputs": [
      {
        "name": "sessionId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "seller",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "assets",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "units",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "params",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct ExitMarket.SessionParams",
        "components": [
          {
            "name": "startBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "stepBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "stepInterval",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "capBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "duration",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "payMask",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "UnsoldWithdrawn",
    "inputs": [
      {
        "name": "sessionId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "seller",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "units",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "assets",
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
    "name": "BidTooSmall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DebtTooSmall",
    "inputs": [
      {
        "name": "debt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "DiscountBelowBid",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EscrowTouched",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FlashLiquidityTooLow",
    "inputs": [
      {
        "name": "chunk",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "HealthDecreased",
    "inputs": [
      {
        "name": "before",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "afterwards",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InsufficientFill",
    "inputs": [
      {
        "name": "filled",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "minFilled",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoCollateralToken",
    "inputs": [
      {
        "name": "payToken",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoFlashLiquidity",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotBidder",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotEnoughUnits",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotSeller",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PayTokenNotAccepted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PriceTooHigh",
    "inputs": [
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxPay",
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
    "name": "SamePaymentAsset",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SessionClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnexpectedCallback",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownBid",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;
