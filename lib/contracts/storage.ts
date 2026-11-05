import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { keccak256 } from "viem";
import { AppError, storageRoot } from "../store";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export async function storeContent(bytes: Buffer, mime: string, name: string, origin: string) {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(storageRoot, "content");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, sha), bytes, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
  await fs.writeFile(path.join(dir, `${sha}.json`), JSON.stringify({ mime }), { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
  let uri = `${origin}/api/content/${sha}`;
  if (process.env.PINATA_JWT) {
    const body = new FormData();
    body.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), name);
    body.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
    const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` }, body, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new AppError("IPFS upload failed. Check pinning configuration and retry; no review was proposed.", 503);
    const result = await response.json();
    if (typeof result.IpfsHash !== "string" || !/^[a-zA-Z0-9]+$/.test(result.IpfsHash)) throw new AppError("IPFS returned an invalid content identifier.", 503);
    uri = `ipfs://${result.IpfsHash}`;
  }
  return { uri, hash: keccak256(bytes) };
}

export async function loadContent(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new AppError("Content not found.", 404);
  try {
    const dir = path.join(storageRoot, "content");
    const [bytes, info] = await Promise.all([fs.readFile(path.join(dir, hash)), fs.readFile(path.join(dir, `${hash}.json`), "utf8")]);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new AppError("Stored content failed its integrity check.", 500);
    return { bytes, mime: JSON.parse(info).mime as string };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError("Content not found.", 404); throw error; }
}
