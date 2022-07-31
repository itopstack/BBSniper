const ethers = require("ethers");
const dotenv = require("dotenv");

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
const account = wallet.connect(provider);
const recipient = account.address;
const minBnbForPair = 1;

const factory = new ethers.Contract(
  addresses.factory,
  [
    "event PairCreated(address indexed token0, address indexed token1, address pair, uint)",
  ],
  account
);

const router = new ethers.Contract(
  addresses.router,
  [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
    "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)",
  ],
  account
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
  account
);

factory.on("PairCreated", async (token0, token1, addressPair) => {
  console.log(`
    ~~~~~~~~~~~~~~~~~~
    New pair detected
    ~~~~~~~~~~~~~~~~~~
    token0: ${token0}
    token1: ${token1}
    addressPair: ${addressPair}
    `);

  const pairBNBvalue = await erc.balanceOf(addressPair);
  const jmlBnb = await ethers.utils.formatEther(pairBNBvalue);
  console.log(`Pair value BNB: ${jmlBnb}`);

  if (jmlBnb < minBnbForPair) {
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

  const amountIn = ethers.utils.parseUnits("0.001", "ether"); //ether is the measurement, not the coin
  const amounts = await router.getAmountsOut(amountIn, [buyToken, sellToken]);

  const amountOutMin = amounts[1].sub(amounts[1].div(10)); // math for Big numbers in JS
  console.log(`
    ~~~~~~~~~~~~~~~~~~~~
    Buying new token
    ~~~~~~~~~~~~~~~~~~~~
    buyToken: ${amountIn.toString()} ${buyToken} (WBNB)
    sellToken: ${amountOutMin.toString()} ${sellToken}
    `);

  const tx = await router.swapExactTokensForTokens(
    amountIn,
    amountOutMin,
    [buyToken, sellToken],
    recipient,
    Date.now() + 1000 * 60 * 5 //5 minutes
  );

  const receipt = await tx.wait();
  console.log("Transaction receipt");
  console.log(receipt);
});
