import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SiweMessage } from "siwe";

// Each run uses its own local data namespace; it never modifies a user's studio.
const namespace = `test-${randomUUID()}`;
const port = 3017;
const base = `http://127.0.0.1:${port}`;
let server;
let output = "";
async function start() {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: process.cwd(), env: { ...process.env, CONSENTCRAFT_DATA_NAMESPACE: namespace }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", b => output += b); server.stderr.on("data", b => output += b);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/api/studio")).ok) return; } catch {}
    if (server.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Server did not start: ${output}`);
}
async function stop() { if (server && server.exitCode === null) { const ended = once(server, "exit"); server.kill(); await ended; } }
function client() {
  let cookie = "";
  return {
    async get(query = "") { const r = await fetch(base + "/api/studio" + query, { headers: { Cookie: cookie } }); return { status: r.status, body: await r.json() }; },
    async post(body, status = 200, origin = base) { const r = await fetch(base + "/api/studio", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify(body) }); const data = await r.json(); assert.equal(r.status, status, `${body.action}: ${JSON.stringify(data)}`); const session = r.headers.get("set-cookie"); if (session) cookie = session.split(";")[0]; return data; }
  };
}
try {
  await start();
  const accounts = Array.from({ length: 4 }, () => client()); const outsider = client();
  const emptyStudio = (await outsider.get()).body;
  assert.deepEqual(emptyStudio, { user: null, projects: [], comics: [], invitations: [] });
  await outsider.post({ action: "demo" }, 401);
  for (let i = 0; i < accounts.length; i++) await accounts[i].post({ action: "signup", name: `Creator ${i + 1}`, email: `creator${i}@example.test`, password: "prototype-test-password" });
  const owner = accounts[0];
  const { id } = await owner.post({ action: "create", title: "Four voices, one story", description: "Integration test comic", genre: "Adventure" });
  const getProject = async (who = owner) => (await who.get()).body.projects.find(p => p.id === id);
  const mutate = async (who, action, extra = {}, expected = 200) => { const p = await getProject(who); return who.post({ action, id, revision: p.revision, ...extra }, expected); };
  assert.equal((await getProject()).genre, "Adventure");
  assert.ok((await getProject()).panels.every(p => !p.image && !p.dialogue && !p.alt));
  assert.equal((await owner.get()).body.projects.length, 1);
  assert.equal((await accounts[1].get()).body.projects.length, 0);
  await mutate(owner, "review", {}, 400);
  console.log("PASS empty account workspaces, no sample content, saved genre, and incomplete draft gate");
  assert.equal((await outsider.get()).body.projects.length, 0);
  await outsider.post({ action: "save", id }, 401);
  await accounts[1].post({ action: "approve", id, revision: 1 }, 404);
  assert.equal((await accounts[1].get(`?invitations=${id}`)).status, 404);
  await owner.post({ action: "create", title: "CSRF attempt" }, 403, "https://unrelated.example");
  console.log("PASS private drafts, membership authorization, and cross-origin rejection");

  for (let i = 1; i < accounts.length; i++) {
    const invite = await owner.post({ action: "invite", id, email: `creator${i}@example.test` });
    await owner.post({ action: "invite", id, email: `creator${i}@example.test` }, 409);
    const inbox = (await accounts[i].get()).body.invitations;
    assert.equal(inbox.length, 1); assert.equal(inbox[0].projectTitle, "Four voices, one story");
    assert.equal((await outsider.get()).body.invitations.length, 0);
    if (i === 1) await accounts[2].post({ action: "accept", token: invite.token }, 403);
    await accounts[i].post({ action: "accept", token: invite.token });
    assert.equal((await accounts[i].get()).body.invitations.length, 0);
    await accounts[i].post({ action: "accept", token: invite.token }, 404);
  }
  assert.equal((await getProject()).members.length, 4);
  const canceled = await owner.post({ action: "invite", id, email: "unused@example.test" });
  await owner.post({ action: "cancelInvite", id, invitation: canceled.token });
  assert.equal((await owner.get(`?invitations=${id}`)).body.invitations.length, 0);
  console.log("PASS dynamic four-person team, email-bound single-use invitations, cancellation");

  let p = await getProject(); const oldRevision = p.revision;
  const png = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#c6b3ed" } }).png().toBuffer();
  const image = `data:image/png;base64,${png.toString("base64")}`;
  const payload = { title: p.title, description: p.description, terms: p.terms, members: p.members.map(m => ({ ...m, share: 2500 })), panels: Array.from({ length: 4 }, (_, i) => ({ image, dialogue: i ? `Panel ${i + 1}` : "", alt: `Uploaded illustration, scene ${i + 1}` })) };
  for (const invalid of ["/art/space.svg", "data:image/png;base64,iVBORw0KGgo=", `data:image/jpeg;base64,${png.toString("base64")}`]) {
    await mutate(owner, "save", { ...payload, panels: payload.panels.map((p, i) => i ? p : { ...p, image: invalid }) }, 400);
  }
  assert.equal((await getProject()).revision, oldRevision);
  await mutate(owner, "save", payload);
  const uploaded = (await getProject()).panels[0];
  assert.ok(uploaded.image.startsWith("data:image/jpeg;base64,"));
  assert.equal(uploaded.dialogue, "");
  const decoded = await sharp(Buffer.from(uploaded.image.split(",")[1], "base64")).metadata();
  assert.equal(decoded.width, 16); assert.equal(decoded.height, 12);
  console.log("PASS uploaded images decode correctly, invalid images reject atomically, and captions stay optional");
  await owner.post({ action: "save", id, revision: oldRevision, ...payload }, 409);
  await mutate(accounts[1], "review", {}, 403);
  const beforeConcurrent = await getProject();
  await Promise.all([owner.post({ action: "save", id, revision: beforeConcurrent.revision, ...payload }), new Promise(resolve => setTimeout(resolve, 50)).then(() => accounts[1].post({ action: "save", id, revision: beforeConcurrent.revision, ...payload }, 409))]);
  console.log("PASS persistence, exact integer shares, and stale/concurrent edit protection");

  await mutate(owner, "save", { ...payload, members: payload.members.map(m => ({ ...m, share: 2400 })) });
  await mutate(owner, "review", {}, 400);
  await mutate(owner, "save", payload);
  await mutate(owner, "review");
  await mutate(owner, "publish", {}, 403);
  await mutate(owner, "save", payload, 409);
  await owner.post({ action: "invite", id, email: "late@example.test" }, 403);
  await mutate(accounts[0], "approve"); await mutate(accounts[1], "approve");
  await mutate(accounts[1], "revoke");
  assert.equal((await getProject()).approvals.length, 1);
  await mutate(owner, "revise");
  assert.deepEqual((await getProject()).approvals, []);
  await mutate(owner, "review");
  assert.equal((await getProject()).version, 2);
  for (const account of accounts) await mutate(account, "approve");
  await mutate(accounts[1], "publish", {}, 403);
  await mutate(owner, "publish");
  assert.equal((await outsider.get()).body.comics.find(p => p.id === id).state, "published");
  await mutate(owner, "save", payload, 409);
  await mutate(owner, "publish", {}, 409);
  assert.equal((await fetch(base + `/comics/${id}`)).status, 200);
  console.log("PASS freeze, revocation, revision invalidation, unanimous publish gate, and immutable reader page");

  const saved = JSON.parse(await readFile(path.join(process.cwd(), ".data", namespace, "studio.json"), "utf8"));
  assert.ok(saved.users.every(u => u.password !== "prototype-test-password" && u.password.length === 128));
  await stop(); await start();
  assert.equal((await getProject()).state, "published");
  await owner.post({ action: "logout" }); assert.equal((await owner.get()).body.user, null);
  await owner.post({ action: "login", email: "creator0@example.test", password: "wrong-password" }, 401);
  await owner.post({ action: "login", email: "creator0@example.test", password: "prototype-test-password" });
  assert.equal((await getProject()).members.length, 4);
  console.log("PASS server restart persistence, password hashing, sign-out, and sign-in");

  // Web3 / RainbowKit SIWE authentication tests
  const walletAccount = privateKeyToAccount(generatePrivateKey());
  const walletClient = client();

  // 1. Fetch nonce
  const nonceRes = await walletClient.get("?action=nonce");
  assert.ok(nonceRes.body.nonce && typeof nonceRes.body.nonce === "string");
  const nonce = nonceRes.body.nonce;

  // 2. Prepare SIWE message
  const siweMsg = new SiweMessage({
    domain: "127.0.0.1:3017",
    address: walletAccount.address,
    statement: "Sign in with Ethereum to ConsentCraft.",
    uri: "http://127.0.0.1:3017",
    version: "1",
    chainId: 1,
    nonce,
  }).prepareMessage();

  // 3. Sign message with wallet
  const signature = await walletAccount.signMessage({ message: siweMsg });

  // Signatures from another site, wrong signers, and malformed messages must fail.
  const foreignMessage = new SiweMessage({ domain: "unrelated.example", address: walletAccount.address, uri: "https://unrelated.example", version: "1", chainId: 1, nonce }).prepareMessage();
  await walletClient.post({ action: "siwe", message: foreignMessage, signature: await walletAccount.signMessage({ message: foreignMessage }) }, 401);
  const wrongSigner = privateKeyToAccount(generatePrivateKey());
  await walletClient.post({ action: "siwe", message: siweMsg, signature: await wrongSigner.signMessage({ message: siweMsg }) }, 401);
  await walletClient.post({ action: "siwe", message: "not a SIWE message", signature }, 401);

  // 4. Authenticate via SIWE
  const siweAuth = await walletClient.post({ action: "siwe", message: siweMsg, signature });
  assert.equal(siweAuth.ok, true);
  assert.equal(siweAuth.user.address.toLowerCase(), walletAccount.address.toLowerCase());

  // 5. Replay attack rejection (nonce already consumed)
  await walletClient.post({ action: "siwe", message: siweMsg, signature }, 401);

  // 6. Verified studio state for wallet user
  const studioState = await walletClient.get();
  assert.equal(studioState.body.user.address.toLowerCase(), walletAccount.address.toLowerCase());

  // 7. Wallet user can create a project
  const walletProject = await walletClient.post({ action: "create", title: "Web3 Story", description: "Created with RainbowKit wallet", theme: "ramen" });
  assert.ok(walletProject.id);

  // Wallet invitations must work for both address casing and inbox visibility.
  const walletInviteProject = await owner.post({ action: "create", title: "Wallet collaboration" });
  const walletInvite = await owner.post({ action: "invite", id: walletInviteProject.id, email: walletAccount.address });
  assert.equal((await walletClient.get()).body.invitations[0].id, walletInvite.token);
  await walletClient.post({ action: "accept", token: walletInvite.token });
  assert.equal((await walletClient.get()).body.projects.find(p => p.id === walletInviteProject.id).members.length, 2);
  console.log("PASS wallet-address invitation inbox and acceptance");

  // 8. Sign out wallet user
  await walletClient.post({ action: "logout" });
  assert.equal((await walletClient.get()).body.user, null);
  console.log("PASS RainbowKit SIWE nonce generation, wallet signature auth, replay rejection, and session management");

  // Upgrade an old database in isolation. Archive demo content without deleting user work.
  await stop();
  const dataFile = path.join(process.cwd(), ".data", namespace, "studio.json");
  const legacy = JSON.parse(await readFile(dataFile, "utf8"));
  delete legacy.schemaVersion;
  legacy.users.push({ id: "legacy-demo", name: "Alex", email: "demo-old@local.invalid", color: "purple" });
  legacy.sessions.push({ token: "legacy-session", userId: "legacy-demo", expires: Date.now() + 60000 });
  legacy.projects.push({ ...legacy.projects[0], id: "sample-old", sample: true });
  legacy.projects.push({ ...legacy.projects[0], id: "demo-old", ownerId: "legacy-demo" });
  await writeFile(dataFile, JSON.stringify(legacy));
  await start();
  const migrated = (await owner.get()).body;
  assert.ok(migrated.projects.some(p => p.id === id));
  assert.ok(migrated.comics.every(p => !p.sample && p.ownerId !== "legacy-demo"));
  const archive = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(archive.archivedDemoProjects.length, 2);
  assert.ok(archive.sessions.every(s => s.userId !== "legacy-demo"));
  await owner.get();
  assert.equal(JSON.parse(await readFile(dataFile, "utf8")).archivedDemoProjects.length, 2);
  console.log("PASS non-destructive, idempotent demo archive and normal account preservation");

  console.log("All integration checks passed. Isolated test namespace: " + namespace);
} catch (error) { console.error(output); throw error; } finally { await stop(); }
