import { connectorsForWallets, getDefaultConfig } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { hardhat, sepolia } from "wagmi/chains";
import { targetChain } from "./contracts/config";

export const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

export const config = projectId ? getDefaultConfig({
  appName: "ConsentCraft",
  projectId,
  chains: [targetChain, ...(targetChain.id === hardhat.id ? [sepolia] : [hardhat])],
  ssr: true,
}) : createConfig({
  chains: [targetChain, ...(targetChain.id === hardhat.id ? [sepolia] : [hardhat])],
  connectors: connectorsForWallets([{ groupName: "Browser wallets", wallets: [injectedWallet] }], { appName: "ConsentCraft", projectId: "" }),
  transports: { [hardhat.id]: http("http://127.0.0.1:8545"), [sepolia.id]: http() },
  ssr: true,
});
