const ethers = require("ethers");
require("dotenv").config();
const fetch = require("node-fetch");
const Web3 = require("web3");
const InputDataDecoder = require("ethereum-input-data-decoder");

const addresses = {
  WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
};

const privateKey = process.env.PRIVATE_KEY;
const node = process.env.NODE;
const provider = new ethers.providers.WebSocketProvider(node);
const wallet = new ethers.Wallet(privateKey);
const signer = wallet.connect(provider);
const recipient = signer.address;
const targetAddress = process.env.TARGET;
const minBnbForPair = process.env.MIN_POOL_BNB;
const myGasPrice = ethers.utils.parseUnits(`${process.env.GAS_PRICE}`, "gwei");
const myGasLimit = process.env.GAS_LIMIT;
const profitXAmount = process.env.PROFIT;
const investmentBnb = process.env.INVESTMENT;
const slippagePercentage = process.env.SLIPPAGE;

const factory = new ethers.Contract(
  addresses.factory,
  [
    "event PairCreated(address indexed token0, address indexed token1, address pair, uint)",
    "function getPair(address tokenA, address tokenB) external view returns (address pair)",
  ],
  signer
);

const router = new ethers.Contract(
  addresses.router,
  [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
    "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
    "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
  ],
  signer
);

const erc = new ethers.Contract(
  addresses.WBNB,
  ["function balanceOf(address _owner) public view returns (uint256 balance)"],
  signer
);

const tokenAbi = [
  "function approve(address spender, uint amount) public returns (bool)",
  "function balanceOf(address _owner) public view returns (uint256 balance)",
  "event Transfer(address indexed _from, address indexed _to, uint256 _value)",
];

const abiDecoder = new InputDataDecoder([
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amountTokenDesired", type: "uint256" },
      { internalType: "uint256", name: "amountTokenMin", type: "uint256" },
      { internalType: "uint256", name: "amountETHMin", type: "uint256" },
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "deadline", type: "uint256" },
    ],
    name: "addLiquidityETH",
    outputs: [
      { internalType: "uint256", name: "amountToken", type: "uint256" },
      { internalType: "uint256", name: "amountETH", type: "uint256" },
      { internalType: "uint256", name: "liquidity", type: "uint256" },
    ],
    stateMutability: "payable",
    type: "function",
  },
]);
const ws = new Web3.providers.WebsocketProvider(node);
const web3 = new Web3(ws);

console.log("Seaching target liquidity...");
const subscription = web3.eth
  .subscribe("pendingTransactions", function (error, result) {})
  .on("data", function (transaction) {
    web3.eth.getTransaction(transaction).then(async (tx) => {
      if (
        tx != null &&
        tx.to == web3.utils.toChecksumAddress(addresses.router)
      ) {
        let data;
        try {
          data = abiDecoder.decodeData(tx.input);
        } catch {
          return;
        }

        if (data.method == "addLiquidityETH") {
          console.log("Found target liquidity. Perform more checking...");

          const pair = await factory.getPair(addresses.WBNB, data.inputs[0]);
          const pairContract = new ethers.Contract(
            pair,
            [
              {
                constant: true,
                inputs: [],
                name: "token0",
                outputs: [
                  { internalType: "address", name: "", type: "address" },
                ],
                payable: false,
                stateMutability: "view",
                type: "function",
              },
              {
                constant: true,
                inputs: [],
                name: "token1",
                outputs: [
                  { internalType: "address", name: "", type: "address" },
                ],
                payable: false,
                stateMutability: "view",
                type: "function",
              },
            ],
            signer
          );

          const token0 = await pairContract.token0();
          const token1 = await pairContract.token1();

          // This block ensures we pay with WBNB
          let buyToken, sellToken;
          if (token0 === addresses.WBNB) {
            buyToken = token0;
            sellToken = token1;
          }
          if (token1 === addresses.WBNB) {
            buyToken = token1;
            sellToken = token0;
          }

          if (typeof buyToken === "undefined") {
            console.log("Neither token is WBNB and we cannot purchase");
            return;
          }

          const pairBNBvalue = await erc.balanceOf(pair);
          const poolBnb = ethers.utils.formatEther(pairBNBvalue);
          console.log(`Pair value BNB: ${poolBnb}`);

          if (poolBnb < minBnbForPair) {
            console.log(
              "Pool has BNB value less than minimum required BNB. Skip it."
            );
            return;
          }

          const response = await fetch(
            `https://aywt3wreda.execute-api.eu-west-1.amazonaws.com/default/IsHoneypot?chain=bsc2&token=${sellToken}`
          );
          const json = await response.json();
          if (json.IsHoneypot) {
            console.log("Token is honey pot. Skip it.");
            return;
          }

          subscription.unsubscribe();

          const amountIn = ethers.utils.parseUnits(`${investmentBnb}`, "ether");
          const amounts = await router.getAmountsOut(amountIn, [
            buyToken,
            sellToken,
          ]);
          const amountOutMin = amounts[1].sub(
            amounts[1].div(100).mul(slippagePercentage)
          );

          console.log(`
    ~~~~~~~~~~~~~~~~~~~~
    Buying new token
    ~~~~~~~~~~~~~~~~~~~~
    buyToken: ${amountIn.toString()} ${buyToken} (WBNB in wei)
    sellToken: ${amountOutMin.toString()} ${sellToken} in wei
    `);

          const tx = await router.swapExactETHForTokens(
            amountOutMin,
            [buyToken, sellToken],
            recipient,
            Date.now() + 1000 * 60 * 5, //5 minutes
            {
              value: amountIn,
              gasLimit: myGasLimit,
              gasPrice: myGasPrice,
            }
          );

          const receipt = await tx.wait();
          console.log(`Buy transaction hash: ${receipt.transactionHash}`);

          const contract = new ethers.Contract(sellToken, tokenAbi, signer);
          const valueToApprove = ethers.utils.parseUnits(
            `${Number.MAX_SAFE_INTEGER}`,
            "ether"
          );

          console.log("Approving sell token...");

          const approvedTx = await contract.approve(
            addresses.router,
            valueToApprove,
            {
              gasPrice: myGasPrice,
              gasLimit: myGasLimit,
            }
          );

          const approvedReceipt = await approvedTx.wait();
          console.log(
            `Approved transaction hash: ${approvedReceipt.transactionHash}`
          );

          console.log("Check profit...");

          const transferEventName = "Transfer";
          contract.on(transferEventName, async (from, to, value) => {
            const balance = await contract.balanceOf(recipient);
            const amount = await router.getAmountsOut(balance, [
              sellToken,
              buyToken,
            ]);
            const profitDesired = amountIn.mul(profitXAmount);
            const currentValue = amount[1];

            console.log(
              "Current Value:",
              ethers.utils.formatUnits(currentValue),
              "Profit Wanted:",
              ethers.utils.formatUnits(profitDesired)
            );

            if (currentValue.gte(profitDesired)) {
              console.log("Selling token to take profit...");

              const amountsOutMin = currentValue.sub(
                currentValue.div(100).mul(slippagePercentage)
              );

              const tx = await router.swapExactTokensForETH(
                amount[0],
                amountsOutMin,
                [sellToken, buyToken],
                recipient,
                Date.now() + 1000 * 60 * 5,
                {
                  gasPrice: myGasPrice,
                  gasLimit: myGasLimit,
                }
              );

              const receipt = await tx.wait();
              console.log(`Sell Transaction hash: ${receipt.transactionHash}`);

              process.exit();
            }
          });
        }
      }
    });
  });

//let isSniping = false;

// console.log("Seaching target pair...");
// factory.on("PairCreated", async (token0, token1, addressPair) => {
//   // if (isSniping) {
//   //   console.log("Already snipe some token. Wait until that task finished");
//   //   return;
//   // }

//   if (token0 !== targetAddress || token1 !== targetAddress) {
//     console.log("Waiting target address to be founded");
//     return;
//   }

//   console.log(`
//     ~~~~~~~~~~~~~~~~~~
//     New pair detected
//     ~~~~~~~~~~~~~~~~~~
//     token0: ${token0}
//     token1: ${token1}
//     addressPair: ${addressPair}
//     `);

//   // This block ensures we pay with WBNB
//   let buyToken, sellToken;
//   if (token0 === addresses.WBNB) {
//     buyToken = token0;
//     sellToken = token1;
//   }
//   if (token1 === addresses.WBNB) {
//     buyToken = token1;
//     sellToken = token0;
//   }

//   if (typeof buyToken === "undefined") {
//     console.log("Neither token is WBNB and we cannot purchase");
//     return;
//   }

//   /*
//   const pairBNBvalue = await erc.balanceOf(addressPair);
//   const poolBnb = ethers.utils.formatEther(pairBNBvalue);
//   console.log(`Pair value BNB: ${poolBnb}`);

//   if (poolBnb < minBnbForPair) {
//     console.log("Pool has BNB value less than minimum required BNB. Skip it.");
//     return;
//   }

//   const response = await fetch(
//     `https://aywt3wreda.execute-api.eu-west-1.amazonaws.com/default/IsHoneypot?chain=bsc2&token=${sellToken}`
//   );
//   const json = await response.json();
//   if (json.IsHoneypot) {
//     console.log("Token is honey pot. Skip it.");
//     return;
//   }
//   */

//   const amountIn = ethers.utils.parseUnits(`${investmentBnb}`, "ether");
//   const amounts = await router.getAmountsOut(amountIn, [buyToken, sellToken]);
//   const amountOutMin = amounts[1].sub(
//     amounts[1].div(100).mul(slippagePercentage)
//   );

//   console.log(`
//     ~~~~~~~~~~~~~~~~~~~~
//     Buying new token
//     ~~~~~~~~~~~~~~~~~~~~
//     buyToken: ${amountIn.toString()} ${buyToken} (WBNB in wei)
//     sellToken: ${amountOutMin.toString()} ${sellToken} in wei
//     `);

//   // isSniping = true;

//   const tx = await router.swapExactETHForTokens(
//     amountOutMin,
//     [buyToken, sellToken],
//     recipient,
//     Date.now() + 1000 * 60 * 5, //5 minutes
//     {
//       value: amountIn,
//       gasLimit: myGasLimit,
//       gasPrice: myGasPrice,
//     }
//   );

//   const receipt = await tx.wait();
//   console.log("Buy transaction receipt");
//   console.log(receipt);

//   const contract = new ethers.Contract(sellToken, tokenAbi, signer);
//   const valueToApprove = ethers.utils.parseUnits(
//     `${Number.MAX_SAFE_INTEGER}`,
//     "ether"
//   );

//   console.log("Approving sell token...");

//   const approvedTx = await contract.approve(addresses.router, valueToApprove, {
//     gasPrice: myGasPrice,
//     gasLimit: myGasLimit,
//   });

//   const approvedReceipt = await approvedTx.wait();
//   console.log("Approved transaction receipt");
//   console.log(approvedReceipt);

//   console.log("Check profit...");

//   const transferEventName = "Transfer";
//   contract.on(transferEventName, async (from, to, value) => {
//     const balance = await contract.balanceOf(recipient);
//     const amount = await router.getAmountsOut(balance, [sellToken, buyToken]);
//     const profitDesired = amountIn.mul(profitXAmount);
//     const currentValue = amount[1];

//     console.log(
//       "Current Value:",
//       ethers.utils.formatUnits(currentValue),
//       "Profit Wanted:",
//       ethers.utils.formatUnits(profitDesired)
//     );

//     if (currentValue.gte(profitDesired)) {
//       console.log("Selling token to take profit...");

//       const amountsOutMin = currentValue.sub(
//         currentValue.div(100).mul(slippagePercentage)
//       );

//       const tx = await router.swapExactTokensForETH(
//         amount[0],
//         amountsOutMin,
//         [sellToken, buyToken],
//         recipient,
//         Date.now() + 1000 * 60 * 5,
//         {
//           gasPrice: myGasPrice,
//           gasLimit: myGasLimit,
//         }
//       );

//       const receipt = await tx.wait();
//       console.log("Sell Transaction receipt");
//       console.log(receipt);

//       process.exit();

//       // contract.removeListener(transferEventName, () => {
//       //   console.log("Unsubscribed current contract before start over again");
//       //   isSniping = false;
//       // });
//     }
//   });
// });
