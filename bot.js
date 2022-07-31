const ethers = require("ethers");
const dotenv = require("dotenv");
const fetch = require("node-fetch");

dotenv.config();

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
const minBnbForPair = 50;
const myGasPrice = ethers.utils.parseUnits("6", "gwei");
const myGasLimit = 300000;
const profitXAmount = 2;
const investmentBnb = 0.01;
const slippagePercentage = 5;

const factory = new ethers.Contract(
  addresses.factory,
  [
    "event PairCreated(address indexed token0, address indexed token1, address pair, uint)",
  ],
  signer
);

const router = new ethers.Contract(
  addresses.router,
  [
    "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)",
    "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
    "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
  ],
  signer
);

const erc = new ethers.Contract(
  addresses.WBNB,
  [
    {
      constant: true,
      inputs: [{ name: "_owner", type: "address" }],
      name: "balanceOf",
      outputs: [{ name: "balance", type: "uint256" }],
      payable: false,
      type: "function",
    },
  ],
  signer
);

const tokenAbi = [
  "function approve(address spender, uint amount) public returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint amount)",
];

let isSniping = false;

factory.on("PairCreated", async (token0, token1, addressPair) => {
  if (isSniping) {
    console.log("Already snipe some token. Wait until that task finished");
    return;
  }

  console.log(`
    ~~~~~~~~~~~~~~~~~~
    New pair detected
    ~~~~~~~~~~~~~~~~~~
    token0: ${token0}
    token1: ${token1}
    addressPair: ${addressPair}
    `);

  const pairBNBvalue = await erc.balanceOf(addressPair);
  const poolBnb = await ethers.utils.formatEther(pairBNBvalue);
  console.log(`Pair value BNB: ${poolBnb}`);

  if (poolBnb < minBnbForPair) {
    console.log("Pool has BNB value less than minimum required BNB. Skip it.");
    return;
  }

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

  const response = await fetch(
    `https://aywt3wreda.execute-api.eu-west-1.amazonaws.com/default/IsHoneypot?chain=bsc2&token=${sellToken}`
  );
  const json = await response.json();
  if (json.IsHoneypot) {
    console.log("Token is honey pot. Skip it.");
    return;
  }

  const amountIn = ethers.utils.parseUnits(`${investmentBnb}`, "ether"); //ether is the measurement, not the coin

  let amounts;
  try {
    amounts = await router.getAmountsOut(amountIn, [buyToken, sellToken]);
  } catch (err) {
    console.log(err);
    return;
  }

  const amountOutMin = amounts[1].sub(
    amounts[1].div(100).mul(slippagePercentage)
  );
  console.log(`
    ~~~~~~~~~~~~~~~~~~~~
    Buying new token
    ~~~~~~~~~~~~~~~~~~~~
    buyToken: ${amountIn.toString()} ${buyToken} (WBNB)
    sellToken: ${amountOutMin.toString()} ${sellToken}
    `);

  isSniping = true;

  let tx;
  try {
    tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
      amountIn,
      amountOutMin,
      [buyToken, sellToken],
      recipient,
      Date.now() + 1000 * 60 * 5, //5 minutes
      {
        gasLimit: myGasLimit,
        gasPrice: myGasPrice,
      }
    );
  } catch (err) {
    console.log(err);
    isSniping = false;
    return;
  }

  const receipt = await tx.wait();
  console.log("Buy transaction receipt");
  console.log(receipt);

  const contract = new ethers.Contract(sellToken, tokenAbi, signer);
  const valueToApprove = ethers.utils.parseUnits("0", "ether");

  let approvedTx;
  console.log("Approving sell token...");

  try {
    approvedTx = await contract.approve(addresses.router, valueToApprove, {
      gasPrice: myGasPrice,
      gasLimit: myGasLimit,
    });
  } catch (err) {
    console.log(err);
    isSniping = false;
    return;
  }

  const approvedReceipt = await approvedTx.wait();

  console.log("Approved transaction receipt");
  console.log(approvedReceipt);
  console.log("Check profit...");

  const transferEventName = "Transfer";
  contract.on(transferEventName, async (from, to, value, event) => {
    const balance = await contract.balanceOf(recipient);

    let amount;
    try {
      amount = await router.getAmountsOut(balance, [sellToken, buyToken]);
    } catch (err) {
      console.log(err);
      return;
    }

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

      let tx;
      try {
        tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
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
      } catch (err) {
        console.log(err);
        return;
      }

      const receipt = await tx.wait();
      console.log("Sell Transaction receipt");
      console.log(receipt);

      contract.removeListener(transferEventName, () => {
        console.log("Unsubscribed current contract before start over again");
        isSniping = false;
      });
    }
  });
});
