import { spawn } from "node:child_process";
for (const args of [["scripts/compile-contracts.mjs"], ["node_modules/next/dist/bin/next", "build"]]) {
  const result = await new Promise((resolve, reject) => { const child = spawn(process.execPath, args, { stdio: "inherit", windowsHide: true }); child.on("error", reject); child.on("exit", resolve); });
  if (result !== 0) process.exit(result || 1);
}
