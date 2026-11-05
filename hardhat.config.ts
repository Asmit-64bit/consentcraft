import { defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: { version: "0.8.38", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" } },
  paths: { sources: "./contracts", artifacts: "./.hardhat-artifacts", cache: "./.hardhat-cache" },
  networks: { default: { type: "edr-simulated", chainType: "l1", chainId: 31337, mining: { auto: true, interval: 1000 } } },
});
