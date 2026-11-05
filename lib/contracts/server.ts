import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createPublicClient, decodeFunctionData, encodeAbiParameters, getAddress, http, isAddress, keccak256, toBytes, type Hex } from "viem";
import { consentCraftAbi } from "./abi";
import { confirmationCount, targetChain } from "./config";
import { canonicalJson, storeContent } from "./storage";
import { ensure, event, type Database } from "../store";
import type { ChainConfig, ChainReview, Project } from "../types";

export const chainClient = createPublicClient({ chain: targetChain, transport: http(process.env.EVM_RPC_URL || (targetChain.id === 31337 ? "http://127.0.0.1:8545" : undefined), { timeout: 12000, retryCount: 1 }), cacheTime: 0 });

export async function chainConfig(): Promise<ChainConfig> {
  let deployment: { address?: string; deploymentTransaction?: string } = {};
  try { deployment = JSON.parse(await fs.readFile(path.join(process.cwd(), "deployments", targetChain.id === 31337 ? "local.json" : "sepolia.json"), "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const address = process.env.NEXT_PUBLIC_CONSENTCRAFT_ADDRESS || deployment.address;
  return { chainId: targetChain.id, name: targetChain.name, contract: address && isAddress(address) ? getAddress(address) : undefined, configured: !!address && isAddress(address), confirmations: confirmationCount, storage: process.env.PINATA_JWT ? "ipfs" : "local", deploymentTransaction: deployment.deploymentTransaction };
}

export async function requireChain() {
  const config = await chainConfig();
  ensure(config.contract, "Deploy ConsentCraft and configure its address before proposing a review.", 503);
  ensure(await chainClient.getChainId() === config.chainId, "The configured RPC is on the wrong network.", 503);
  ensure(await chainClient.getCode({ address: config.contract }), "The ConsentCraft contract is missing. Restart and redeploy the local chain, or check the testnet address.", 503);
  return { ...config, contract: config.contract };
}

export async function prepareReview(db: Database, p: Project, origin: string): Promise<void> {
  const config = await requireChain();
  ensure(config.chainId === 31337 || config.storage === "ipfs", "Configure PINATA_JWT before publishing a Sepolia review package to IPFS.", 503);
  ensure(p.state === "draft", "Reopen the draft before preparing another package.", 409);
  ensure(!p.chainTransactions?.some(t => t.status === "submitted"), "Reconcile the pending transaction before creating a new package.", 409);
  ensure(!db.invitations.some(i => i.projectId === p.id && !i.accepted && Date.parse(i.expiresAt) > Date.now()), "Accept or cancel pending invitations before freezing the team.");
  ensure(p.panels.every(panel => panel.image.startsWith("data:image/") && panel.alt), "Upload all four panels and add their image descriptions.");
  ensure(p.members.every(m => m.share > 0) && p.members.reduce((sum, m) => sum + m.share, 0) === 10000, "Give each contributor a positive share totaling 100%.");
  ensure(p.priceWei && /^\d+$/.test(p.priceWei) && BigInt(p.priceWei) > 0n && BigInt(p.priceWei) < 2n ** 256n, "Set a positive test ETH price before review.");
  const contributors = p.members.map(m => {
    const wallet = db.users.find(u => u.id === m.userId)?.address;
    ensure(wallet && isAddress(wallet), `${m.name} must connect and sign in with a wallet before review.`);
    return { ...m, address: getAddress(wallet) };
  });
  ensure(new Set(contributors.map(m => m.address.toLowerCase())).size === contributors.length, "Each contributor must have a different wallet.");
  const owner = contributors.find(m => m.userId === p.ownerId)!;
  const salt = keccak256(toBytes(p.id));
  const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [owner.address, salt]));
  const current = await chainClient.readContract({ address: config.contract, abi: consentCraftAbi, functionName: "getProject", args: [key] });
  ensure(!current.minted, "This comic was already minted. Its package cannot be edited.", 409);
  if (p.review) {
    ensure(p.review.contract.toLowerCase() === config.contract.toLowerCase() && p.review.chainId === config.chainId, "This project belongs to another contract deployment. Use that deployment or create a fresh project.", 409);
    ensure(current.version >= BigInt(p.review.version), "The local chain was reset. Create a fresh project for this deployment.", 409);
  }
  const assets = [];
  for (const [index, panel] of p.panels.entries()) {
    const bytes = Buffer.from(panel.image.split(",")[1], "base64");
    const mime = panel.image.startsWith("data:image/png") ? "image/png" : "image/jpeg";
    assets.push({ ...(await storeContent(bytes, mime, `panel-${index + 1}.${mime === "image/png" ? "png" : "jpg"}`, origin)), dialogue: panel.dialogue, alt: panel.alt, order: index });
  }
  const terms = await storeContent(Buffer.from(p.terms, "utf8"), "text/plain; charset=utf-8", "terms.txt", origin);
  const credits = contributors.map(({ name, role, share, address }) => ({ name, role, shareBps: share, wallet: address }));
  const manifest = { schema: "consentcraft/1", title: p.title, description: p.description, genre: p.genre, panels: assets, terms, contributors: credits, roundingRecipient: contributors.at(-1)!.address, priceWei: p.priceWei, chainId: config.chainId, contract: config.contract, projectKey: key, version: Number(current.version) + 1 };
  const content = await storeContent(Buffer.from(canonicalJson(manifest), "utf8"), "application/json", "manifest.json", origin);
  const metadata = await storeContent(Buffer.from(canonicalJson({ name: p.title, description: p.description, image: assets[0].uri, external_url: `${origin}/comics/${p.id}`, properties: { manifest: content.uri, contentHash: content.hash, terms: terms.uri, termsHash: terms.hash, contributors: credits, priceWei: p.priceWei, roundingRecipient: contributors.at(-1)!.address } }), "utf8"), "application/json", "metadata.json", origin);
  if (p.review) (p.reviewHistory ||= []).push(structuredClone(p.review));
  p.review = { salt, projectKey: key, chainId: config.chainId, contract: config.contract, manifestUri: content.uri, metadataUri: metadata.uri, termsUri: terms.uri, contentHash: content.hash, termsHash: terms.hash, contributors, priceWei: p.priceWei, expectedVersion: Number(current.version), version: 0, status: "prepared", storage: config.storage, preparedAt: new Date().toISOString(), snapshot: structuredClone({ title: p.title, description: p.description, genre: p.genre, panels: p.panels, terms: p.terms, members: contributors }) };
  p.state = "review"; p.rosterFrozen = true; p.approvals = []; p.revision++;
  event(p, "Prepared the immutable review package. Awaiting the owner's onchain proposal.");
}

function matchesPackage(review: ChainReview, onchain: { contentHash: Hex; termsHash: Hex; metadataURI: string; priceWei: bigint }) {
  return review.contentHash === onchain.contentHash && review.termsHash === onchain.termsHash && review.metadataUri === onchain.metadataURI && review.priceWei === onchain.priceWei.toString();
}

export async function reconcileProject(p: Project) {
  if (!p.review) return;
  const config = await requireChain();
  ensure(config.chainId === p.review.chainId && config.contract.toLowerCase() === p.review.contract.toLowerCase(), "Switch back to this project's contract deployment.", 409);
  const height = await chainClient.getBlockNumber();
  const blockNumber = height >= BigInt(confirmationCount) ? height - BigInt(confirmationCount - 1) : 0n;
  const args = { address: config.contract, abi: consentCraftAbi, blockNumber } as const;
  const [state, roster, approvals] = await Promise.all([
    chainClient.readContract({ ...args, functionName: "getProject", args: [p.review.projectKey] }),
    chainClient.readContract({ ...args, functionName: "getContributors", args: [p.review.projectKey] }),
    chainClient.readContract({ ...args, functionName: "getApprovals", args: [p.review.projectKey] }),
  ]);
  for (const transaction of p.chainTransactions || []) {
    if (transaction.status === "replaced") continue;
    try {
      const receipt = await chainClient.getTransactionReceipt({ hash: transaction.hash });
      transaction.status = receipt.blockNumber > blockNumber ? "submitted" : receipt.status === "success" ? "confirmed" : "reverted";
      transaction.blockNumber = receipt.blockNumber.toString();
      transaction.blockHash = receipt.blockHash; transaction.transactionIndex = receipt.transactionIndex;
    } catch {
      transaction.status = "submitted";
      // A confirmed nonce consumed without this receipt proves replacement/cancellation.
      try { if (await chainClient.getTransactionCount({ address: getAddress(transaction.actor), blockNumber }) > transaction.nonce) transaction.status = "replaced"; } catch { /* Leave unresolved transactions pending when RPC is unavailable. */ }
    }
  }
  if (state.version === 0n) {
    ensure(p.review.status === "prepared", "The contract no longer contains this review. The local chain may have been reset.", 409);
    p.chainError = undefined; return;
  }
  // A newly prepared revision may still have the previous confirmed version onchain.
  if (p.review.status === "prepared" && state.version === BigInt(p.review.expectedVersion) && !state.minted) { p.chainError = undefined; return; }
  ensure(matchesPackage(p.review, state), "Onchain content differs from this review package. Approval is blocked; reopen the draft and prepare a matching version.", 409);
  ensure(roster[0].length === p.review.contributors.length && roster[0].every((wallet, i) => wallet.toLowerCase() === p.review!.contributors[i].address.toLowerCase() && roster[1][i] === p.review!.contributors[i].share), "Onchain contributor shares differ from the displayed package.", 409);
  const old = JSON.stringify([p.state, p.version, p.approvals, p.review.sold, p.review.status]);
  p.review.version = Number(state.version); p.review.digest = state.digest; p.review.status = state.minted ? "minted" : "proposed";
  p.review.tokenId = state.minted ? state.tokenId.toString() : undefined; p.review.sold = state.sold; p.review.confirmedBlock = blockNumber.toString();
  p.review.tokenOwner = state.minted ? await chainClient.readContract({ ...args, functionName: "ownerOf", args: [state.tokenId] }) : undefined;
  p.version = Number(state.version);
  p.approvals = p.review.contributors.filter((_, i) => approvals[i]).map(m => m.userId);
  if (state.minted) { Object.assign(p, structuredClone(p.review.snapshot)); p.state = "published"; p.publishedAt ||= new Date().toISOString(); }
  else if (p.state === "published") { p.state = "review"; p.publishedAt = undefined; }
  p.chainError = undefined;
  if (old !== JSON.stringify([p.state, p.version, p.approvals, p.review.sold, p.review.status])) {
    p.revision++;
    event(p, `Chain confirmed version ${p.version}: ${p.review.sold ? "collectible sold" : state.minted ? "collectible minted into escrow" : `${p.approvals.length}/${p.members.length} wallet approvals`}.`);
  }
}

export async function trackTransaction(p: Project, actor: string, hash: Hex, replaces?: Hex) {
  ensure(p.review, "Prepare a review first.");
  const transaction = await chainClient.getTransaction({ hash });
  ensure(transaction.from.toLowerCase() === actor.toLowerCase() && transaction.to?.toLowerCase() === p.review.contract.toLowerCase(), "This transaction does not belong to your wallet and this contract.", 403);
  const decoded = decodeFunctionData({ abi: consentCraftAbi, data: transaction.input });
  const first = decoded.args?.[0];
  const relevant = decoded.functionName === "proposeVersion" ? first === p.review.salt : decoded.functionName === "buyComic" ? first?.toString() === p.review.tokenId : ["setApproval", "mintComic"].includes(decoded.functionName) && first === p.review.projectKey;
  ensure(relevant, "This transaction is for a different project.", 400);
  const transactions = p.chainTransactions ||= [];
  if (!transactions.some(t => t.hash === hash)) transactions.push({ hash, action: decoded.functionName, actor, at: new Date().toISOString(), status: "submitted", nonce: transaction.nonce, replaces });
  if (replaces) {
    const old = transactions.find(t => t.hash === replaces);
    if (old) { ensure(old.nonce === transaction.nonce && old.actor.toLowerCase() === transaction.from.toLowerCase(), "Invalid replacement transaction."); old.status = "replaced"; }
  }
}
