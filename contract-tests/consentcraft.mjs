import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, http, keccak256, toBytes, zeroAddress, zeroHash } from "viem";
import { hardhat } from "viem/chains";

const transport = http("http://127.0.0.1:8546", { retryCount: 0 });
const client = createPublicClient({ chain: hardhat, transport, pollingInterval: 100 });
const node = spawn(process.execPath, ["node_modules/hardhat/dist/src/cli.js", "node", "--network", "default", "--hostname", "127.0.0.1", "--port", "8546"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = ""; node.stdout.on("data", data => output += data); node.stderr.on("data", data => output += data);
try {
  for (let n = 0; ; n++) {
    try { await client.getChainId(); break; } catch { if (n > 100 || node.exitCode !== null) throw new Error(`Local test node failed: ${output.slice(-2500)}`); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  const addresses = await client.request({ method: "eth_accounts" });
  const wallets = addresses.map(account => createWalletClient({ account, chain: hardhat, transport }));
  const artifact = JSON.parse(await readFile("artifacts/ConsentCraft.json", "utf8"));
  const deployment = await wallets[0].deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
  const address = (await client.waitForTransactionReceipt({ hash: deployment })).contractAddress;
  const read = (functionName, args = []) => client.readContract({ address, abi: artifact.abi, functionName, args });
  const write = async (who, functionName, args = [], value = 0n) => {
    const { request } = await client.simulateContract({ account: addresses[who], address, abi: artifact.abi, functionName, args, value });
    const hash = await wallets[who].writeContract(request);
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success"); return hash;
  };
  const fails = (who, functionName, args, value = 0n) => assert.rejects(client.simulateContract({ account: addresses[who], address, abi: artifact.abi, functionName, args, value }));
  const salt = keccak256(toBytes("four-person-contract-test"));
  const key = await read("projectKey", [addresses[0], salt]);
  const proposal = { contentHash: keccak256(toBytes("manifest bytes")), termsHash: keccak256(toBytes("terms bytes")), metadataURI: "ipfs://test-only-metadata", contributors: addresses.slice(0, 4), shares: [2500, 2500, 2500, 2500], priceWei: 10003n };
  for (const bad of [{ ...proposal, shares: [2500, 2500, 2500, 2400] }, { ...proposal, contributors: [addresses[0], addresses[1], addresses[1], addresses[3]] }, { ...proposal, contributors: [addresses[0], addresses[1], zeroAddress, addresses[3]] }, { ...proposal, shares: [0, 5000, 2500, 2500] }, { ...proposal, priceWei: 0n }, { ...proposal, contentHash: zeroHash }]) await fails(0, "proposeVersion", [salt, 0n, bad]);
  await write(0, "proposeVersion", [salt, 0n, proposal]);
  let project = await read("getProject", [key]);
  assert.equal(project.version, 1n); assert.equal((await read("getContributors", [key]))[0].length, 4);
  await fails(0, "proposeVersion", [salt, 0n, proposal]);
  await fails(4, "setApproval", [key, 1n, project.digest, true]);
  await fails(0, "setApproval", [key, 1n, zeroHash, true]);
  await fails(4, "mintComic", [key, 1n, project.digest]);
  console.log("PASS dynamic contributors, unique positive shares, owner namespace, and version/digest binding");

  for (let i = 0; i < 3; i++) await write(i, "setApproval", [key, 1n, project.digest, true]);
  await fails(0, "mintComic", [key, 1n, project.digest]);
  await write(2, "setApproval", [key, 1n, project.digest, false]);
  assert.equal((await read("getApprovals", [key]))[2], false);
  const changed = { ...proposal, contentHash: keccak256(toBytes("revised manifest")) };
  await fails(0, "proposeVersion", [salt, 1n, { ...changed, contributors: [addresses[0], addresses[1], addresses[2], addresses[5]] }]);
  await write(0, "proposeVersion", [salt, 1n, changed]);
  project = await read("getProject", [key]); assert.equal(project.version, 2n);
  assert.deepEqual(await read("getApprovals", [key]), [false, false, false, false]);
  await fails(0, "setApproval", [key, 1n, project.digest, true]);
  for (let i = 0; i < 4; i++) await write(i, "setApproval", [key, 2n, project.digest, true]);
  await write(0, "mintComic", [key, 2n, project.digest]);
  project = await read("getProject", [key]);
  assert.equal((await read("ownerOf", [project.tokenId])).toLowerCase(), address.toLowerCase());
  assert.equal(await read("tokenURI", [project.tokenId]), proposal.metadataURI);
  await fails(0, "mintComic", [key, 2n, project.digest]);
  await fails(0, "proposeVersion", [salt, 2n, proposal]);
  await fails(0, "setApproval", [key, 2n, project.digest, false]);
  console.log("PASS missing consent, revocation, frozen roster, stale approval rejection, ERC-721 escrow, and mint-once rules");

  await fails(4, "buyComic", [project.tokenId], proposal.priceWei - 1n);
  await fails(4, "buyComic", [project.tokenId], proposal.priceWei + 1n);
  await write(4, "buyComic", [project.tokenId], proposal.priceWei);
  assert.equal((await read("ownerOf", [project.tokenId])).toLowerCase(), addresses[4].toLowerCase());
  const balances = await Promise.all(addresses.slice(0, 4).map(a => read("pendingPayments", [a])));
  assert.deepEqual(balances, [2500n, 2500n, 2500n, 2503n]);
  assert.equal(balances.reduce((a, b) => a + b, 0n), proposal.priceWei);
  assert.equal(await read("totalPendingPayments"), proposal.priceWei);
  await fails(5, "buyComic", [project.tokenId], proposal.priceWei);
  console.log("PASS exact-price one-time purchase, token transfer, complete wei allocation, and last-contributor rounding");

  for (const name of ["RejectEther", "ReenterWithdrawal"]) {
    const receiver = JSON.parse(await readFile(`artifacts/${name}.json`, "utf8"));
    const hash = await wallets[0].deployContract({ abi: receiver.abi, bytecode: receiver.bytecode, args: name === "ReenterWithdrawal" ? [address] : [] });
    const target = (await client.waitForTransactionReceipt({ hash })).contractAddress;
    await fails(0, "withdraw", [target]);
    assert.equal(await read("pendingPayments", [addresses[0]]), 2500n);
  }
  await fails(0, "withdraw", [zeroAddress]);
  const before = await client.getBalance({ address: addresses[9] });
  for (let i = 0; i < 4; i++) await write(i, "withdraw", [addresses[9]]);
  assert.equal((await client.getBalance({ address: addresses[9] })) - before, proposal.priceWei);
  assert.equal(await read("totalPendingPayments"), 0n);
  assert.equal(await client.getBalance({ address }), 0n);
  await fails(0, "withdraw", [addresses[0]]);
  console.log("PASS failed recipient isolation, reentrancy rejection, full withdrawals, and zero remaining liabilities");
  console.log("All Solidity contract checks passed on an isolated Hardhat EVM.");
} finally { if (node.exitCode === null) { const ended = once(node, "exit"); node.kill(); await ended; } }
