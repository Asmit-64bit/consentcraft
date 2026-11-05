import { connectorsForWallets, getDefaultConfig } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { mainnet, sepolia, base, polygon, optimism, arbitrum } from "wagmi/chains";

export const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

export const config = projectId ? getDefaultConfig({
  appName: "ConsentCraft",
  projectId,
  chains: [mainnet, sepolia, base, polygon, optimism, arbitrum],
  ssr: true,
}) : createConfig({
  chains: [mainnet, sepolia, base, polygon, optimism, arbitrum],
  connectors: connectorsForWallets([{ groupName: "Browser wallets", wallets: [injectedWallet] }], { appName: "ConsentCraft", projectId: "" }),
  transports: { [mainnet.id]: http(), [sepolia.id]: http(), [base.id]: http(), [polygon.id]: http(), [optimism.id]: http(), [arbitrum.id]: http() },
  ssr: true,
});
