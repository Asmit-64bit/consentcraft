import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

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
  for (let i = 0; i < accounts.length; i++) await accounts[i].post({ action: "signup", name: `Creator ${i + 1}`, email: `creator${i}@example.test`, password: "prototype-test-password" });
  const owner = accounts[0];
  const { id } = await owner.post({ action: "create", title: "Four voices, one story", description: "Integration test comic", theme: "space" });
  const getProject = async (who = owner) => (await who.get()).body.projects.find(p => p.id === id);
  const mutate = async (who, action, extra = {}, expected = 200) => { const p = await getProject(who); return who.post({ action, id, revision: p.revision, ...extra }, expected); };
  assert.equal((await outsider.get()).body.projects.length, 0);
  await outsider.post({ action: "save", id }, 401);
  await accounts[1].post({ action: "approve", id, revision: 1 }, 404);
  assert.equal((await accounts[1].get(`?invitations=${id}`)).status, 404);
  await owner.post({ action: "create", title: "CSRF attempt" }, 403, "https://unrelated.example");
  console.log("PASS private drafts, membership authorization, and cross-origin rejection");

  for (let i = 1; i < accounts.length; i++) {
    const invite = await owner.post({ action: "invite", id, email: `creator${i}@example.test` });
    if (i === 1) await accounts[2].post({ action: "accept", token: invite.token }, 403);
    await accounts[i].post({ action: "accept", token: invite.token });
    await accounts[i].post({ action: "accept", token: invite.token }, 404);
  }
  assert.equal((await getProject()).members.length, 4);
  const canceled = await owner.post({ action: "invite", id, email: "unused@example.test" });
  await owner.post({ action: "cancelInvite", id, invitation: canceled.token });
  assert.equal((await owner.get(`?invitations=${id}`)).body.invitations.length, 0);
  console.log("PASS dynamic four-person team, email-bound single-use invitations, cancellation");

  let p = await getProject(); const oldRevision = p.revision;
  const payload = { title: p.title, description: p.description, terms: p.terms, members: p.members.map(m => ({ ...m, share: 2500 })), panels: Array.from({ length: 4 }, (_, i) => ({ image: `/art/space.svg#panel-${i}`, dialogue: `Panel ${i + 1}`, alt: `An astronaut, scene ${i + 1}` })) };
  await mutate(owner, "save", payload);
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
  console.log("All integration checks passed. Isolated test namespace: " + namespace);
} catch (error) { console.error(output); throw error; } finally { await stop(); }
