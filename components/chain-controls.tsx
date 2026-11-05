"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { encodeFunctionData, formatEther, getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { consentCraftAbi } from "@/lib/contracts/abi";
import { contentLink, explorerTransaction, targetChain } from "@/lib/contracts/config";
import type { ChainConfig, Project, User } from "@/lib/types";
import { Icon } from "./icons";

type Call =
  | { functionName: "proposeVersion"; args: readonly [Hex, bigint, { contentHash: Hex; termsHash: Hex; metadataURI: string; contributors: Address[]; shares: number[]; priceWei: bigint }] }
  | { functionName: "setApproval"; args: readonly [Hex, bigint, Hex, boolean] }
  | { functionName: "mintComic"; args: readonly [Hex, bigint, Hex] }
  | { functionName: "buyComic"; args: readonly [bigint]; value: bigint }
  | { functionName: "withdraw"; args: readonly [Address] };
type Pending = { hash: Hex; label: string; actor: Address; projectId?: string };
function persistPending(key: string, pending?: Pending) { try { if (pending) localStorage.setItem(key, JSON.stringify(pending)); else localStorage.removeItem(key); return true; } catch { return false; } }
function encodeCall(call: Call): Hex {
  switch (call.functionName) {
    case "proposeVersion": return encodeFunctionData({ abi: consentCraftAbi, ...call });
    case "setApproval": return encodeFunctionData({ abi: consentCraftAbi, ...call });
    case "mintComic": return encodeFunctionData({ abi: consentCraftAbi, ...call });
    case "buyComic": return encodeFunctionData({ abi: consentCraftAbi, ...call });
    case "withdraw": return encodeFunctionData({ abi: consentCraftAbi, ...call });
  }
}
type Execute = (body: Record<string, unknown>, message?: string) => Promise<unknown>;
const errorText = (error: unknown) => {
  const e = error as { shortMessage?: string; message?: string };
  const message = e.shortMessage || e.message || "Transaction could not be completed.";
  return /rejected|denied/i.test(message) ? "You declined the wallet request. Nothing was submitted." : message;
};

export function useChainConfig() {
  const query = useQuery<ChainConfig>({ queryKey: ["chain-config", targetChain.id], queryFn: async () => { const response = await fetch("/api/chain", { cache: "no-store" }); if (!response.ok) throw new Error("Network configuration could not load."); return response.json(); }, staleTime: 10000, refetchInterval: 30000 });
  return { config: query.data || (query.error ? { chainId: targetChain.id, name: targetChain.name, confirmations: 2, configured: false, storage: "local" as const, error: query.error.message } : undefined), refreshConfig: query.refetch };
}

function useTransaction(user: User | null, projectId: string | undefined, onConfirmed: () => Promise<void>) {
  const { config, refreshConfig } = useChainConfig();
  const account = useAccount(); const { data: wallet } = useWalletClient(); const publicClient = usePublicClient({ chainId: targetChain.id }); const { switchChainAsync } = useSwitchChain();
  const [error, setError] = useState(""); const [message, setMessage] = useState(""); const [stage, setStage] = useState("");
  const [quote, setQuote] = useState<{ call: Call; label: string; gas: string }>();
  const [pending, setPending] = useState<Pending>(); const [retry, setRetry] = useState(0);
  const key = config?.contract && account.address ? `consentcraft:pending:${config.chainId}:${config.contract}:${account.address}:${projectId || "earnings"}` : undefined;
  const matches = !!account.address && user?.address?.toLowerCase() === account.address.toLowerCase();
  const ready = !!config?.contract && !config.error && matches && account.chainId === targetChain.id;
  const busy = !!stage || !!pending;
  const record = useCallback(async (transaction: Pending, replaces?: Hex) => {
    if (!transaction.projectId) return;
    const response = await fetch("/api/chain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: transaction.projectId, hash: transaction.hash, replaces }) });
    if (!response.ok) throw new Error("Transaction is saved in this browser. Server tracking will retry when you check it again.");
  }, []);

  useEffect(() => {
    if (!key) return;
    Promise.resolve().then(() => { setQuote(undefined); setStage(""); try { const saved = localStorage.getItem(key); const value = saved ? JSON.parse(saved) : undefined; setPending(value && /^0x[a-fA-F0-9]{64}$/.test(value.hash) ? value : undefined); } catch { setPending(undefined); setError("Could not recover browser transaction history."); } });
  }, [key]);

  useEffect(() => {
    if (!pending || !publicClient || !key || pending.actor.toLowerCase() !== account.address?.toLowerCase()) return;
    let active = true; let replaced = false;
    Promise.resolve().then(() => { if (active) { setStage("Confirming on Ethereum…"); setError(""); } });
    record(pending).catch(() => {});
    publicClient.waitForTransactionReceipt({ hash: pending.hash, confirmations: 2, pollingInterval: 1500, timeout: 120000, onReplaced: replacement => {
      if (!active) return;
      replaced = replacement.reason !== "repriced";
      const next = { ...pending, hash: replacement.transaction.hash };
      persistPending(key, next);
      if (!replaced) record(next, pending.hash).catch(() => {});
    } }).then(async receipt => {
      if (!active) return;
      persistPending(key); setPending(undefined); setStage(""); setQuote(undefined);
      if (receipt.status !== "success") setError("The transaction reverted. No contract changes were made.");
      else setMessage(replaced ? "The transaction was replaced or canceled. Current chain state has been refreshed." : `${pending.label} confirmed with 2 confirmations.`);
      try { await onConfirmed(); } catch { setError("Transaction confirmed. Refresh the page to reconcile the latest state."); }
    }).catch(error => { if (active) { setStage(""); setError(`Confirmation is still unresolved. Your transaction hash is saved; check it before sending another. ${errorText(error)}`); } });
    return () => { active = false; };
  }, [account.address, key, onConfirmed, pending, publicClient, record, retry]);

  const prepare = async (call: Call, label: string) => {
    setError(""); setMessage("");
    if (!ready || !account.address || !config?.contract || !publicClient) { setError("Connect your signed-in wallet on the configured network first."); return; }
    setStage("Simulating transaction…");
    try {
      const parameters = { to: config.contract, account: account.address, data: encodeCall(call), value: "value" in call ? call.value : 0n };
      await publicClient.call(parameters);
      const [gas, fees] = await Promise.all([publicClient.estimateGas(parameters), publicClient.estimateFeesPerGas()]);
      setQuote({ call, label, gas: formatEther(gas * (fees.maxFeePerGas ?? 0n)) });
    } catch (error) { setError(errorText(error)); } finally { setStage(""); }
  };
  const send = async () => {
    if (!quote || !ready || !wallet || !publicClient || !config?.contract || !account.address || !key) return;
    setError(""); setStage("Confirm in your wallet…");
    try {
      const parameters = { to: config.contract, account: account.address, data: encodeCall(quote.call), value: "value" in quote.call ? quote.call.value : 0n };
      await publicClient.call(parameters);
      const hash = await wallet.sendTransaction({ ...parameters, chain: targetChain });
      const transaction: Pending = { hash, label: quote.label, actor: account.address, projectId };
      // Persist immediately after submission, before waiting on any server request.
      if (!persistPending(key, transaction)) setError("Browser storage is unavailable. Keep the displayed transaction hash until confirmation."); setPending(transaction); setQuote(undefined);
      record(transaction).catch(() => {});
    } catch (error) { setError(errorText(error)); setStage(""); }
  };
  const controls = <>
    {config && <div className="chain-network"><span className="green-dot"/>{config.name} · test ETH · 2 confirmations</div>}
    {config?.error && <div className="form-error" role="alert">{config.error} <button className="text-button" onClick={() => refreshConfig().catch(e => setError(e.message))}>Check connection</button></div>}
    {!matches && <div className="chain-connect"><p>Connect and sign in with {user?.address ? "your account’s wallet" : "an Ethereum wallet"} to transact.</p><ConnectButton label="Connect & sign in" showBalance={false}/></div>}
    {matches && account.chainId !== targetChain.id && <button className="button purple full" onClick={() => switchChainAsync({ chainId: targetChain.id }).catch(e => setError(errorText(e)))}>Switch to {targetChain.name}</button>}
    {quote && <div className="transaction-quote"><strong>{quote.label}</strong><p>Estimated maximum network fee: {quote.gas} test ETH. Your wallet shows the final fee.</p>{"value" in quote.call && <p>Purchase price: {formatEther(quote.call.value)} test ETH, plus gas.</p>}<div className="chain-button-row"><button className="button yellow" disabled={!ready || busy} onClick={send}>Confirm in wallet<Icon name="arrow" size={16}/></button><button className="text-button" disabled={busy} onClick={() => setQuote(undefined)}>Cancel</button></div></div>}
    {(stage || pending) && <div className="chain-progress" role="status"><strong>{stage || "Transaction pending"}</strong>{pending && <><TransactionLink hash={pending.hash} chainId={targetChain.id}/><button className="text-button" onClick={() => setRetry(n => n + 1)}>Check transaction again</button></>}</div>}
    {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="chain-success" role="status">{message}</p>}
  </>;
  return { config, ready, busy: busy || !!quote, prepare, controls, publicClient, address: account.address };
}

export function TransactionLink({ hash, chainId }: { hash: string; chainId: number }) {
  const href = explorerTransaction(chainId, hash);
  return href ? <a className="chain-hash" href={href} target="_blank" rel="noreferrer">{hash}<Icon name="arrow" size={13}/></a> : <code className="chain-hash">{hash}</code>;
}

export function OnchainReview({ project: p, user, dirty, execute, refresh }: { project: Project; user: User; dirty: boolean; execute: Execute; refresh: () => Promise<void> }) {
  const tx = useTransaction(user, p.id, refresh);
  const [consent, setConsent] = useState(false); const [publicConsent, setPublicConsent] = useState(false); const [error, setError] = useState(""); const [working, setWorking] = useState(false);
  const owner = p.ownerId === user.id; const r = p.review; const approved = p.approvals.includes(user.id);
  const mutation = async (action: string) => { setWorking(true); setError(""); try { await execute({ action, id: p.id, revision: p.revision, publicationConsent: publicConsent }); } catch (e) { setError(errorText(e)); } finally { setWorking(false); } };
  const approve = (value: boolean) => r?.digest && tx.prepare({ functionName: "setApproval", args: [r.projectKey, BigInt(r.version), r.digest, value] }, value ? "Approval" : "Approval withdrawal");
  const disabled = tx.busy || working || !!p.chainError;
  return <section className="surface review-surface"><span className="eyebrow">WALLET CONSENT. ENFORCED ONCHAIN.</span><h2>{p.state === "draft" ? "Prepare the exact work everyone will approve." : r?.status === "prepared" ? "Your package is ready for Ethereum." : `Review version ${r?.version || p.version}`}</h2>
    <p className="muted">Artwork, terms, ordered shares, and price are bound to one version. A new onchain proposal invalidates all earlier approvals.</p>
    {tx.controls}{p.chainError && <p className="form-error" role="alert">{p.chainError}</p>}
    {p.state === "draft" ? <>
      <div className="review-checklist">{[[p.panels.every(panel => panel.image && panel.alt), "Four uploaded panels with image descriptions"], [p.members.every(m => m.address), "Every contributor has a signed-in wallet"], [p.members.every(m => m.share > 0) && p.members.reduce((sum, m) => sum + m.share, 0) === 10000, "Positive contributor shares total 100%"], [BigInt(p.priceWei || "0") > 0n, "Primary sale price is set in test ETH"], [!dirty, "All draft changes saved"]].map(([done, label], i) => <div key={i}><span className={`check-circle ${done ? "complete" : ""}`}><Icon name={done ? "check" : "clock"} size={14}/></span>{label}</div>)}</div>
      {owner ? <><label className="checkbox-label"><input type="checkbox" checked={publicConsent} onChange={e => setPublicConsent(e.target.checked)}/><span>I understand that preparing this package makes its artwork, credits, wallet addresses, and terms publicly accessible{tx.config?.storage === "ipfs" ? " on IPFS" : " on this server"}. The team roster then freezes.</span></label><button className="button purple full" disabled={disabled || dirty || !publicConsent || !user.address || !!tx.config?.error} onClick={() => mutation("review")}>{working ? "Preparing immutable package…" : "Prepare review package"}<Icon name="shield" size={18}/></button></> : <p className="info-banner">The owner prepares the review package after everyone has added their wallet and work.</p>}
    </> : r && <>
      <div className="chain-price"><span>Agreed primary sale</span><strong>{formatEther(BigInt(r.priceWei))} test ETH</strong></div>
      <div className="terms-box"><h3>Artwork use terms</h3><p>{r.snapshot.terms}</p><div className="review-shares">{r.contributors.map((member, index) => <div key={member.userId}><span><strong>{member.name}</strong><small>{member.role} · {member.address}</small>{index === r.contributors.length - 1 && <small>Receives any rounding remainder</small>}</span><strong>{member.share / 100}%</strong></div>)}</div></div>
      <div className="chain-links"><a href={contentLink(r.manifestUri)} target="_blank" rel="noreferrer">Review manifest ↗</a><a href={contentLink(r.termsUri)} target="_blank" rel="noreferrer">Exact terms ↗</a><a href={contentLink(r.metadataUri)} target="_blank" rel="noreferrer">NFT metadata ↗</a></div>
      <details className="chain-proof"><summary>Verify package and contract</summary><p>Contract</p><code>{r.contract}</code><p>Manifest hash (Keccak-256)</p><code>{r.contentHash}</code><p>Approval digest</p><code>{r.digest || "Available after proposal confirmation"}</code><p>Storage: {r.storage === "ipfs" ? "IPFS" : "local immutable files — keep this server running"}</p></details>
      {r.status === "prepared" ? owner ? <button className="button purple full" disabled={!tx.ready || disabled} onClick={() => tx.prepare({ functionName: "proposeVersion", args: [r.salt, BigInt(r.expectedVersion), { contentHash: r.contentHash, termsHash: r.termsHash, metadataURI: r.metadataUri, contributors: r.contributors.map(m => m.address), shares: r.contributors.map(m => m.share), priceWei: BigInt(r.priceWei) }] }, "Version proposal")}>Propose version onchain<Icon name="arrow" size={18}/></button> : <p className="info-banner">Waiting for the owner to confirm the proposal in their wallet.</p> : <>
        <div className="approval-list">{r.contributors.map(member => <div key={member.userId}><span>{member.name}</span><span className={`approval-state ${p.approvals.includes(member.userId) ? "approved" : ""}`}><Icon name={p.approvals.includes(member.userId) ? "check" : "clock"} size={14}/>{p.approvals.includes(member.userId) ? "Approved onchain" : "Awaiting consent"}</span></div>)}</div>
        {approved ? <button className="button full" disabled={!tx.ready || disabled} onClick={() => approve(false)}>Withdraw my onchain approval</button> : <><label className="checkbox-label"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/><span>I reviewed this exact comic, terms, price, ordered shares, and rounding recipient. I approve minting this version into a fixed-price escrow listing.</span></label><button className="button purple full" disabled={!consent || !tx.ready || disabled} onClick={() => approve(true)}>Approve version {r.version} onchain</button></>}
        {owner && <div className="publish-actions"><p className="field-hint">Minting is permanent: no delisting, price change, refund, or later approval revocation. The collectible stays in contract escrow until its first purchase.</p><button className="button yellow full" disabled={!tx.ready || disabled || p.approvals.length !== p.members.length} onClick={() => tx.prepare({ functionName: "mintComic", args: [r.projectKey, BigInt(r.version), r.digest!] }, "Comic mint")}>Mint collectible · {p.approvals.length}/{p.members.length} approvals</button></div>}
      </>}
      {owner && <button className="text-button chain-revise" disabled={disabled || (approved && !tx.ready)} onClick={() => approved ? approve(false) : mutation("revise")}>{approved ? "Withdraw your approval before editing" : "Reopen draft for a new version"}<Icon name="edit" size={15}/></button>}
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <ChainHistory project={p}/>
  </section>;
}

export function ChainHistory({ project }: { project: Project }) {
  return project.chainTransactions?.length ? <div className="chain-history"><h3>Wallet transactions</h3>{[...project.chainTransactions].reverse().map(tx => <div key={tx.hash}><strong>{tx.action} · {tx.status}</strong><TransactionLink hash={tx.hash} chainId={project.review!.chainId}/></div>)}</div> : null;
}

export function CollectibleActions({ project: p, user, refresh }: { project: Project; user: User | null; refresh: () => Promise<void> }) {
  const tx = useTransaction(user, p.id, refresh); const [understood, setUnderstood] = useState(false); const r = p.review;
  if (!r?.tokenId) return null;
  return <section className="surface collectible-sale"><div><span className="eyebrow">ERC-721 · {r.chainId === 31337 ? "LOCAL ETHEREUM" : "SEPOLIA"}</span><h2>{r.sold ? "Collected." : "Own this shared story."}</h2><p className="muted">Token #{r.tokenId} · {formatEther(BigInt(r.priceWei))} test ETH</p><p className="field-hint">The token is a collectible. Artwork reuse follows the creators’ terms; buying does not transfer copyright.</p><div className="chain-links"><a href={contentLink(r.manifestUri)} target="_blank" rel="noreferrer">Approved comic package ↗</a><a href={contentLink(r.metadataUri)} target="_blank" rel="noreferrer">Token metadata ↗</a></div><details className="chain-proof"><summary>Contract and ownership</summary><p>Contract</p><code>{r.contract}</code><p>Current owner</p><code>{r.tokenOwner}</code></details></div><div>{tx.controls}{r.sold ? <p className="chain-success">The primary sale is complete. Contributor allocations can be withdrawn from Earnings.</p> : <><label className="checkbox-label"><input type="checkbox" checked={understood} onChange={e => setUnderstood(e.target.checked)}/><span>I reviewed the comic and use terms. This test ETH purchase is final and has no refund.</span></label><button className="button yellow full" disabled={!tx.ready || tx.busy || !understood || !!p.chainError} onClick={() => tx.prepare({ functionName: "buyComic", args: [BigInt(r.tokenId!)], value: BigInt(r.priceWei) }, "Collectible purchase")}>Buy for {formatEther(BigInt(r.priceWei))} test ETH<Icon name="arrow" size={17}/></button></>}</div></section>;
}

export function EarningsPage({ user }: { user: User | null }) {
  const { config } = useChainConfig(); const client = usePublicClient({ chainId: targetChain.id }); const [recipient, setRecipient] = useState("");
  const { data: balance, error, refetch } = useQuery({ queryKey: ["earnings", targetChain.id, config?.contract, user?.address], enabled: !!config?.contract && !!user?.address && !!client, queryFn: async () => client!.readContract({ address: config!.contract!, abi: consentCraftAbi, functionName: "pendingPayments", args: [getAddress(user!.address!)] }), refetchInterval: 15000 });
  const refresh = useCallback(async () => { await refetch(); }, [refetch]);
  const tx = useTransaction(user, undefined, refresh);
  const destination = recipient || user?.address || "";
  const valid = isAddress(destination) && destination.toLowerCase() !== zeroAddress && destination.toLowerCase() !== config?.contract?.toLowerCase();
  return <><div className="page-heading"><div><span className="eyebrow">YOUR SHARE, IN YOUR CONTROL</span><h1>Earnings from your stories.</h1><p>Primary-sale proceeds allocated by the contract, ready for you to withdraw.</p></div></div><section className="surface earnings-card">{tx.controls}<div className="earnings-balance"><span>Available to withdraw</span><strong>{balance === undefined ? "—" : formatEther(balance)} <small>test ETH</small></strong></div><p className="muted">Only your wallet can withdraw its allocation. The contract sends it to the recipient you choose.</p><label>Recipient wallet<input value={destination} onChange={e => setRecipient(e.target.value)} placeholder="0x wallet address" spellCheck={false}/></label><div className="chain-button-row"><button className="button yellow" disabled={!tx.ready || tx.busy || !valid || balance === undefined || balance === 0n} onClick={() => tx.prepare({ functionName: "withdraw", args: [getAddress(destination)] }, "Proceeds withdrawal")}>Withdraw proceeds<Icon name="arrow" size={17}/></button><button className="text-button" onClick={refresh}>Refresh balance</button></div>{balance === 0n && <p className="field-hint">No proceeds are waiting. Your allocation appears after a collectible’s primary sale.</p>}{error && <p className="form-error" role="alert">{error.message}</p>}</section></>;
}

export function NetworkPage() {
  const { config, refreshConfig } = useChainConfig();
  return <><div className="page-heading"><div><span className="eyebrow">THE WEB3 CONNECTION</span><h1>Ethereum, connected to your craft.</h1><p>Contract consent, ERC-721 escrow, primary sales, and withdrawals.</p></div></div><section className="surface network-card"><h2>{config?.name || "Checking network…"}</h2><p className="muted">Chain ID: {config?.chainId} · Confirmation threshold: 2</p><h3>ConsentCraft contract</h3><code className="chain-hash">{config?.contract || "No contract configured"}</code>{config?.deploymentTransaction && <TransactionLink chainId={config.chainId} hash={config.deploymentTransaction}/>}<p className="field-hint">{config?.storage === "ipfs" ? "Review packages are pinned to IPFS, with a local backup." : "Review packages use immutable local storage. Sepolia reviews require IPFS pinning configuration."}</p>{config?.error ? <p className="form-error" role="alert">{config.error}</p> : config?.configured && <p className="chain-success">Contract found. Wallet actions simulate before submission and wait for two confirmations.</p>}<button className="button purple" onClick={() => refreshConfig()}>Check connection</button><p className="field-hint">{config?.chainId === 31337 ? "Local test chain: connect a development wallet funded by Hardhat. Resetting the node removes its chain history; old projects cannot be migrated by changing an address." : "Sepolia uses test ETH. A funded wallet signs every transaction; the server never signs on behalf of contributors."}</p><Link className="text-button" href="/help">Read the workflow<Icon name="arrow" size={16}/></Link></section></>;
}
