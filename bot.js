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
const account = wallet.connect(provider);
const recipient = account.address;
const minBnbForPair = 10;
const myGasPrice = ethers.utils.parseUnits("5", "gwei");
const profitXAmount = 2;

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
    "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
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

const tokenAbi = [
  "function approve(address spender, uint amount) public returns(bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint amount)",
  "function transfer(address to, uint amount) returns (bool)",
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

  console.log("Checking honey pot...");
  const response = await fetch(
    `https://aywt3wreda.execute-api.eu-west-1.amazonaws.com/default/IsHoneypot?chain=bsc2&token=${sellToken}`
  );
  const json = await response.json();
  if (json.IsHoneypot) {
    console.log("Token is honey pot. Skip it.");
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
  console.log("Buy transaction receipt");
  console.log(receipt);

  isSniping = true;

  const contract = new ethers.Contract(sellToken, tokenAbi, account);

  const valueToApprove = ethers.utils.parseUnits("0", "ether");
  const approvedTx = await contract.approve(addresses.router, valueToApprove, {
    gasPrice: myGasPrice,
    gasLimit: 210000,
  });

  console.log("Approving sell token...");
  const approvedReceipt = await approvedTx.wait();
  console.log("Approved transaction receipt");
  console.log(approvedReceipt);

  contract.on("Transfer", async (from, to, value, event) => {
    console.log("Check profit...");

    const bal = await contract.balanceOf(recipient);
    const amount = await router.getAmountsOut(bal, [sellToken, buyToken]);
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

      const amountsOutMin = currentValue.sub(currentValue.div(10));
      const tx = await router.swapExactTokensForETH(
        amount[0],
        amountsOutMin,
        [sellToken, buyToken],
        recipient,
        Date.now() + 1000 * 60 * 5,
        {
          gasPrice: myGasPrice,
          gasLimit: 210000,
        }
      );

      const receipt = await tx.wait();
      console.log("Sell Transaction receipt");
      console.log(receipt);

      process.exit();
    }
  });
});
