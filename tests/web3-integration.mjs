import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, getAddress, http, keccak256 } from "viem";
import { hardhat } from "viem/chains";
import { SiweMessage } from "siwe";
import sharp from "sharp";

const base = "http://127.0.0.1:3019";
const transport = http("http://127.0.0.1:8547", { retryCount: 0 });
const chain = createPublicClient({ chain: hardhat, transport, pollingInterval: 100 });
const namespace = `web3-test-${randomUUID()}`;
const children = []; let output = "";
function launch(args, env = {}) { const child = spawn(process.execPath, args, { windowsHide: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }); child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b); children.push(child); return child; }
async function ready(check, child) { for (let i = 0; i < 120; i++) { try { if (await check()) return; } catch {} if (child.exitCode !== null) throw new Error(output.slice(-3000)); await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("Test server failed to start."); }
function session() { let cookie = ""; return {
  async get() { const r = await fetch(base + "/api/studio", { headers: { Cookie: cookie } }); assert.equal(r.status, 200); return r.json(); },
  async post(body, expected = 200, endpoint = "/api/studio") { const r = await fetch(base + endpoint, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie }, body: JSON.stringify(body) }); const json = await r.json(); assert.equal(r.status, expected, JSON.stringify(json)); const next = r.headers.get("set-cookie"); if (next) cookie = next.split(";")[0]; return json; }
}; }
try {
  const node = launch(["node_modules/hardhat/dist/src/cli.js", "node", "--network", "default", "--hostname", "127.0.0.1", "--port", "8547"]);
  await ready(() => chain.getChainId(), node);
  const addresses = await chain.request({ method: "eth_accounts" });
  const wallets = addresses.map(account => createWalletClient({ account, chain: hardhat, transport }));
  const artifact = JSON.parse(await readFile("artifacts/ConsentCraft.json", "utf8"));
  const deployment = await wallets[0].deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
  const contract = (await chain.waitForTransactionReceipt({ hash: deployment })).contractAddress;
  const web = launch(["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3019"], { CONSENTCRAFT_DATA_NAMESPACE: namespace, NEXT_PUBLIC_CONSENTCRAFT_ADDRESS: contract, EVM_RPC_URL: "http://127.0.0.1:8547", PINATA_JWT: "", NEXT_PUBLIC_APP_URL: base });
  await ready(async () => (await fetch(base + "/api/chain")).ok, web);
  const sessions = Array.from({ length: 5 }, () => session());
  for (let i = 0; i < sessions.length; i++) {
    const { nonce } = await (await fetch(base + "/api/studio?action=nonce")).json();
    const message = new SiweMessage({ domain: "127.0.0.1:3019", address: getAddress(addresses[i]), uri: base, version: "1", chainId: 31337, nonce }).prepareMessage();
    const signature = await wallets[i].signMessage({ message });
    await sessions[i].post({ action: "siwe", message, signature });
  }
  const owner = sessions[0];
  const { id } = await owner.post({ action: "create", title: "Onchain acceptance test", description: "Four wallet contributors; one collector." });
  const get = async () => (await owner.get()).projects.find(p => p.id === id);
  const mutate = async (action, extra = {}, expected = 200) => { const p = await get(); return owner.post({ action, id, revision: p.revision, ...extra }, expected); };
  for (let i = 1; i < 4; i++) { const invite = await owner.post({ action: "invite", id, email: addresses[i] }); await sessions[i].post({ action: "accept", token: invite.token }); }
  let p = await get();
  const image = `data:image/png;base64,${(await sharp({ create: { width: 16, height: 12, channels: 3, background: "#c6b3ed" } }).png().toBuffer()).toString("base64")}`;
  await mutate("save", { title: p.title, description: p.description, terms: p.terms, members: p.members.map(m => ({ ...m, share: 2500 })), priceWei: "10003", panels: Array.from({ length: 4 }, (_, i) => ({ image, dialogue: i ? `Panel ${i + 1}` : "", alt: `Uploaded panel ${i + 1}` })) });
  await mutate("review", {}, 400);
  await mutate("review", { publicationConsent: true });
  p = await get(); assert.equal(p.review.status, "prepared"); assert.equal(p.version, 0);
  const bytes = Buffer.from(await (await fetch(p.review.manifestUri)).arrayBuffer());
  assert.equal(keccak256(bytes), p.review.contentHash);
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(manifest.priceWei, "10003"); assert.equal(manifest.roundingRecipient.toLowerCase(), addresses[3].toLowerCase());
  assert.ok(!bytes.toString("utf8").includes("wallet.invalid"));
  for (const panel of manifest.panels) assert.equal(keccak256(new Uint8Array(await (await fetch(panel.uri)).arrayBuffer())), panel.hash);
  assert.equal(keccak256(new Uint8Array(await (await fetch(p.review.termsUri)).arrayBuffer())), p.review.termsHash);
  await mutate("approve", {}, 403); await mutate("publish", {}, 403);
  console.log("PASS wallet-authenticated dynamic team, immutable bytes, asset/terms hashes, exact wei price, and no server approval bypass");

  // A wallet cancellation must not leave the project permanently blocked by a stale pending hash.
  await chain.request({ method: "evm_setIntervalMining", params: [0] });
  await chain.request({ method: "evm_setAutomine", params: [false] });
  const original = p.review;
  const proposalArgs = [original.salt, 0n, { contentHash: original.contentHash, termsHash: original.termsHash, metadataURI: original.metadataUri, contributors: original.contributors.map(m => m.address), shares: original.contributors.map(m => m.share), priceWei: BigInt(original.priceWei) }];
  const nonce = await chain.getTransactionCount({ address: addresses[0] });
  const canceledHash = await wallets[0].writeContract({ address: contract, abi: artifact.abi, functionName: "proposeVersion", args: proposalArgs, gas: 1500000n, gasPrice: 10000000000n, nonce });
  await owner.post({ id, hash: canceledHash }, 200, "/api/chain");
  await wallets[0].sendTransaction({ to: addresses[0], value: 0n, gas: 21000n, gasPrice: 20000000000n, nonce });
  await chain.request({ method: "evm_mine" }); await chain.request({ method: "evm_mine" });
  await chain.request({ method: "evm_setAutomine", params: [true] });
  assert.equal((await get()).chainTransactions.find(t => t.hash === canceledHash).status, "replaced");
  assert.equal((await get()).review.status, "prepared");
  console.log("PASS canceled transaction recovery from confirmed nonce without a fabricated proposal");

  let checkedConfirmationThreshold = false;
  async function transact(who, functionName, args, value = 0n) {
    const { request } = await chain.simulateContract({ address: contract, abi: artifact.abi, account: addresses[who], functionName, args, value });
    const hash = await wallets[who].writeContract(request);
    await sessions[who].post({ id, hash }, 200, "/api/chain");
    if (functionName === "proposeVersion" && !checkedConfirmationThreshold) { assert.equal((await get()).review.status, "prepared"); checkedConfirmationThreshold = true; }
    await chain.request({ method: "evm_mine" });
    assert.equal((await chain.waitForTransactionReceipt({ hash, confirmations: 2 })).status, "success");
    return hash;
  }
  const propose = async () => { const r = (await get()).review; await transact(0, "proposeVersion", [r.salt, BigInt(r.expectedVersion), { contentHash: r.contentHash, termsHash: r.termsHash, metadataURI: r.metadataUri, contributors: r.contributors.map(m => m.address), shares: r.contributors.map(m => m.share), priceWei: BigInt(r.priceWei) }]); };
  await propose(); p = await get(); assert.equal(p.review.status, "proposed"); assert.equal(p.version, 1);
  for (let i = 0; i < 3; i++) await transact(i, "setApproval", [p.review.projectKey, 1n, p.review.digest, true]);
  p = await get(); assert.equal(p.approvals.length, 3);
  await assert.rejects(chain.simulateContract({ address: contract, abi: artifact.abi, account: addresses[0], functionName: "mintComic", args: [p.review.projectKey, 1n, p.review.digest] }));
  await transact(0, "setApproval", [p.review.projectKey, 1n, p.review.digest, false]);
  await mutate("revise");
  p = await get();
  await mutate("save", { title: p.title, description: p.description, terms: p.terms, members: p.members, priceWei: p.priceWei, panels: p.panels.map((panel, i) => i ? panel : { ...panel, dialogue: "Changed after review" }) });
  await mutate("review", { publicationConsent: true }); await propose();
  p = await get(); assert.equal(p.version, 2); assert.deepEqual(p.approvals, []);
  for (let i = 0; i < 4; i++) await transact(i, "setApproval", [p.review.projectKey, 2n, p.review.digest, true]);
  await transact(0, "mintComic", [p.review.projectKey, 2n, p.review.digest]);
  p = await get(); assert.equal(p.state, "published"); assert.equal(p.review.tokenId, "1");
  assert.equal((await session().get()).comics[0].id, id);
  assert.equal(p.panels[0].dialogue, "Changed after review");
  assert.ok(p.chainTransactions.every(t => ["confirmed", "replaced"].includes(t.status)));
  assert.equal((await fetch(base + `/comics/${id}`)).status, 200);
  console.log("PASS actual proposal, partial-consent mint rejection, revision invalidation, unanimous mint, receipt reconciliation, and public reader");

  await transact(4, "buyComic", [BigInt(p.review.tokenId)], 10003n);
  p = await get(); assert.equal(p.review.sold, true); assert.equal(p.review.tokenOwner.toLowerCase(), addresses[4].toLowerCase());
  const allocations = await Promise.all(addresses.slice(0, 4).map(account => chain.readContract({ address: contract, abi: artifact.abi, functionName: "pendingPayments", args: [account] })));
  assert.deepEqual(allocations, [2500n, 2500n, 2500n, 2503n]);
  for (let i = 0; i < 4; i++) {
    const { request } = await chain.simulateContract({ address: contract, abi: artifact.abi, account: addresses[i], functionName: "withdraw", args: [addresses[i]] });
    const hash = await wallets[i].writeContract(request); await chain.waitForTransactionReceipt({ hash });
    assert.equal(await chain.readContract({ address: contract, abi: artifact.abi, functionName: "pendingPayments", args: [addresses[i]] }), 0n);
  }
  assert.equal(await chain.getBalance({ address: contract }), 0n);
  console.log("PASS collector purchase, onchain ownership, all allocations, and independent contributor withdrawals");
  console.log("Full Web3 application acceptance flow passed. Isolated data namespace: " + namespace);
} catch (error) { console.error(output.slice(-2500).replace(/Private Key: .*/g, "Private Key: [test key omitted]")); throw error; }
finally { for (const child of children.reverse()) if (child.exitCode === null) { const ended = once(child, "exit"); child.kill(); await ended; } }
