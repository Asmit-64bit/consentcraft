import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { User, Project, Invitation } from "./types";

export type Account = User & { password?: string; salt?: string };
export type Database = { users: Account[]; sessions: { token: string; userId: string; expires: number }[]; projects: Project[]; invitations: Invitation[]; nonces?: { nonce: string; expires: number }[]; schemaVersion?: number; archivedDemoProjects?: Project[] };
export const storageRoot = path.join(process.cwd(), ".data", process.env.CONSENTCRAFT_DATA_NAMESPACE || "studio");
const root = storageRoot;
const file = path.join(root, "studio.json");
const globalStore = globalThis as typeof globalThis & { consentLock?: Promise<unknown> };
export async function database<T>(fn: (db: Database) => T | Promise<T>, write = false): Promise<T> {
  const work = (globalStore.consentLock || Promise.resolve()).catch(() => {}).then(async () => {
    await fs.mkdir(root, { recursive: true });
    let db: Database;
    try { db = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; db = { users: [], sessions: [], projects: [], invitations: [], nonces: [], schemaVersion: 2 }; }
    const migrate = db.schemaVersion !== 2;
    if (migrate) {
      // Preserve old demo work for recovery while removing it from active workspaces.
      const demoUsers = new Set(db.users.filter(u => /^demo-.*@local\.invalid$/.test(u.email) && !u.address).map(u => u.id));
      const demoProjects = db.projects.filter(p => p.sample || demoUsers.has(p.ownerId));
      const demoIds = new Set(demoProjects.map(p => p.id));
      db.archivedDemoProjects = [...(db.archivedDemoProjects || []), ...demoProjects];
      db.projects = db.projects.filter(p => !demoIds.has(p.id));
      db.sessions = db.sessions.filter(s => !demoUsers.has(s.userId));
      db.schemaVersion = 2;
    }
    const result = await fn(db);
    if (write || migrate) { const temp = `${file}.${randomBytes(5).toString("hex")}.tmp`; await fs.writeFile(temp, JSON.stringify(db), { mode: 0o600 }); await fs.rename(temp, file); }
    return result;
  });
  globalStore.consentLock = work;
  return work;
}
export function id() { return randomBytes(16).toString("hex"); }
export function hash(password: string, salt: string) { return scryptSync(password, salt, 64).toString("hex"); }
export function passwordMatches(password: string, account: Account) { if (!account.password || !account.salt) return false; return timingSafeEqual(Buffer.from(hash(password, account.salt), "hex"), Buffer.from(account.password, "hex")); }
export function publicUser(account: Account): User { return { id: account.id, name: account.name, email: account.email, color: account.color, address: account.address }; }
export function sessionUser(db: Database, token?: string) { const session = db.sessions.find(s => s.token === token && s.expires > Date.now()); return db.users.find(u => u.id === session?.userId); }
export class AppError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function ensure(value: unknown, message: string, status = 400): asserts value { if (!value) throw new AppError(message, status); }
export function text(value: unknown, max: number, label: string, required = true) { ensure(typeof value === "string", `${label} must be text.`); const clean = value.trim(); ensure((!required || clean.length > 0) && clean.length <= max, `${label} must be ${required ? "1–" : "at most "}${max} characters.`); return clean; }
export function event(project: Project, message: string) { project.events.unshift({ id: id(), text: message, at: new Date().toISOString() }); project.updatedAt = new Date().toISOString(); }
