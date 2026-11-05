import { hardhat, sepolia } from "viem/chains";
export const targetChain = process.env.NEXT_PUBLIC_CHAIN_ID === "11155111" ? sepolia : { ...hardhat, name: "Local Ethereum" };
export const confirmationCount = 2;
export function explorerTransaction(chainId: number, hash: string) { return chainId === sepolia.id ? `https://sepolia.etherscan.io/tx/${hash}` : undefined; }
export function contentLink(uri: string) { return uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri; }
