import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
await mkdir(".data", { recursive: true });
const log = await open(".data/local-chain.log", "a");
const child = spawn(process.execPath, ["node_modules/hardhat/dist/src/cli.js", "node", "--network", "default", "--hostname", "127.0.0.1", "--port", process.env.CHAIN_PORT || "8545"], { windowsHide: true, stdio: ["ignore", log.fd, log.fd] });
console.log(`Local Ethereum RPC starting at http://127.0.0.1:${process.env.CHAIN_PORT || "8545"} (chain 31337). Logs: .data/local-chain.log`);
console.log("Local chain uses disposable Hardhat accounts. Never use them on a public network.");
process.on("SIGINT", () => child.kill()); process.on("SIGTERM", () => child.kill());
child.on("exit", code => { log.close(); process.exit(code || 0); });
