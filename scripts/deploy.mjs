import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createPublicClient, createWalletClient, http, keccak256 } from "viem";
import { hardhat, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const network = process.argv[2] || "local";
if (!["local", "sepolia"].includes(network)) throw new Error("Choose local or sepolia. Mainnet deployment is intentionally unsupported.");
const local = network === "local";
const chain = local ? hardhat : sepolia;
const rpc = local ? process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545" : process.env.SEPOLIA_RPC_URL;
if (!rpc) throw new Error("Set SEPOLIA_RPC_URL in the deployment shell.");
const publicClient = createPublicClient({ chain, transport: http(rpc) });
if (await publicClient.getChainId() !== chain.id) throw new Error("RPC chain ID does not match the selected network.");
let account;
if (local) [account] = await publicClient.request({ method: "eth_accounts" });
else {
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("Set DEPLOYER_PRIVATE_KEY only in this deployment shell. It needs Sepolia test ETH; never put it in the web app environment.");
  account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
}
const artifact = JSON.parse(await readFile("artifacts/ConsentCraft.json", "utf8"));
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
console.log(`Deployment submitted: ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Deployment reverted.");
const bytecode = await publicClient.getCode({ address: receipt.contractAddress });
if (!bytecode) throw new Error("No deployed bytecode found.");
const deployment = { chainId: chain.id, address: receipt.contractAddress, deploymentTransaction: hash, blockNumber: receipt.blockNumber.toString(), runtimeHash: keccak256(bytecode), compiler: artifact.compiler };
await mkdir("deployments", { recursive: true });
await writeFile(`deployments/${network}.json`, JSON.stringify(deployment, null, 2) + "\n");
console.log(`Deployed ConsentCraft on ${chain.name}: ${receipt.contractAddress}`);
console.log(local ? "The app reads deployments/local.json automatically." : "Set NEXT_PUBLIC_CHAIN_ID=11155111, NEXT_PUBLIC_CONSENTCRAFT_ADDRESS to this address, and EVM_RPC_URL on the web server, then rebuild.");
