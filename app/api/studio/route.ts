import { NextRequest, NextResponse } from "next/server";
import { AppError, database, ensure, event, hash, id, passwordMatches, publicUser, sessionUser, text } from "@/lib/store";
import { templates, samplePanels } from "@/lib/demo";
import type { Panel, Project } from "@/lib/types";

const headers = { "Cache-Control": "no-store" };
function errorResponse(error: unknown) { if (!(error instanceof AppError)) console.error("Studio request failed", error); return NextResponse.json({ error: error instanceof AppError ? error.message : "Something went wrong. Please try again." }, { status: error instanceof AppError ? error.status : 500, headers }); }
export async function GET(req: NextRequest) {
  try { return await database(db => {
    const user = sessionUser(db, req.cookies.get("cc_session")?.value);
    const invitedProject = req.nextUrl.searchParams.get("invitations");
    if (invitedProject) {
      ensure(user && db.projects.some(p => p.id === invitedProject && p.ownerId === user.id), "Project not found.", 404);
      return NextResponse.json({ invitations: db.invitations.filter(i => i.projectId === invitedProject && !i.accepted && Date.parse(i.expiresAt) > Date.now()) }, { headers });
    }
    return NextResponse.json({ user: user ? publicUser(user) : null, projects: user ? db.projects.filter(p => p.members.some(m => m.userId === user.id)) : [], comics: db.projects.filter(p => p.state === "published").map(p => ({ ...p, events: [] })) }, { headers });
  }); } catch (error) { return errorResponse(error); }
}

export async function POST(req: NextRequest) {
  try {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    ensure(host && (origin === `http://${host}` || origin === `https://${host}`), "Request origin is not allowed.", 403);
    ensure(Number(req.headers.get("content-length") || 0) < 16_000_000, "This upload is too large.", 413);
    const raw = await req.text(); ensure(raw.length < 16_000_000, "This upload is too large.", 413);
    let b: Record<string, unknown>; try { b = JSON.parse(raw); } catch { throw new AppError("Invalid request."); }
    ensure(b && typeof b === "object", "Invalid request.");
    return await database(async db => {
      const action = b.action; const token = req.cookies.get("cc_session")?.value;
      let user = sessionUser(db, token);
      if (action === "signup" || action === "login" || action === "demo") {
        if (action === "demo") {
          const uid = id(); user = { id: uid, name: "Alex", email: `demo-${uid}@local.invalid`, color: "purple", salt: id(), password: "" };
          user.password = hash(id(), user.salt); db.users.push(user);
          templates.forEach((t, index) => { const p = newProject(user!.id, user!.name, t.title, t.description, t.theme); p.genre = t.genre; p.panels = samplePanels(t.theme, t.lines); if (index === 1) { p.panels[2] = { image: "", dialogue: "", alt: "" }; p.panels[3] = { image: "", dialogue: "", alt: "" }; } db.projects.push(p); });
        } else {
          const email = text(b.email, 254, "Email").toLowerCase(); ensure(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), "Enter a valid email address.");
          const password = text(b.password, 128, "Password"); ensure(password.length >= 8, "Use at least 8 characters for your password.");
          if (action === "signup") {
            ensure(!db.users.some(u => u.email === email), "An account with this email already exists.", 409);
            const salt = id(); user = { id: id(), name: text(b.name, 60, "Name"), email, color: "purple", salt, password: hash(password, salt) }; db.users.push(user);
          } else { const account = db.users.find(u => u.email === email); ensure(account && passwordMatches(password, account), "Email or password is incorrect.", 401); user = account; }
        }
        const newToken = id() + id(); db.sessions = db.sessions.filter(s => s.expires > Date.now() && s.token !== token); db.sessions.push({ token: newToken, userId: user.id, expires: Date.now() + 7 * 86400000 });
        const res = NextResponse.json({ ok: true }, { headers }); res.cookies.set("cc_session", newToken, { httpOnly: true, sameSite: "strict", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: 7 * 86400 }); return res;
      }
      if (action === "logout") { db.sessions = db.sessions.filter(s => s.token !== token); const res = NextResponse.json({ ok: true }, { headers }); res.cookies.delete("cc_session"); return res; }
      ensure(user, "Sign in to use your studio.", 401);
      if (action === "create") { const p = newProject(user.id, user.name, text(b.title, 80, "Title"), text(b.description ?? "", 1000, "Description", false), ["space", "ramen", "garden"].includes(String(b.theme)) ? String(b.theme) : "space"); db.projects.push(p); return NextResponse.json({ id: p.id }, { headers }); }
      if (action === "accept") {
        const invite = db.invitations.find(i => i.id === b.token); ensure(invite && !invite.accepted && Date.parse(invite.expiresAt) > Date.now(), "This invitation has expired or was already used.", 404);
        ensure(invite.email === user.email, "Sign in with the email address this invitation was sent to.", 403);
        const p = db.projects.find(p => p.id === invite.projectId); ensure(p && !p.rosterFrozen, "This team is already frozen for review.", 409);
        ensure(!p.members.some(m => m.userId === user.id), "You're already on this team.", 409);
        p.members.push({ userId: user.id, name: user.name, role: "Collaborator", share: 0 }); p.revision++; invite.accepted = true; event(p, `${user.name} joined the team.`); return NextResponse.json({ id: p.id }, { headers });
      }
      const p = db.projects.find(p => p.id === b.id); ensure(p && p.members.some(m => m.userId === user.id), "Project not found.", 404);
      const owner = p.ownerId === user.id;
      ensure(p.state !== "published", "Published comics are frozen. Start a new project for a new story.", 409);
      if (action === "cancelInvite") {
        ensure(owner && !p.rosterFrozen, "Only the owner can cancel draft invitations.", 403);
        const invite = db.invitations.find(i => i.id === b.invitation && i.projectId === p.id && !i.accepted);
        ensure(invite, "Invitation not found.", 404); invite.expiresAt = new Date(0).toISOString(); event(p, `${user.name} canceled a pending invitation.`);
        return NextResponse.json({ ok: true }, { headers });
      }
      if (action === "invite") {
        ensure(owner && !p.rosterFrozen, "Only the owner can invite people before the first review.", 403);
        const email = text(b.email, 254, "Email").toLowerCase(); ensure(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), "Enter a valid email address."); ensure(!p.members.some(m => db.users.find(u => u.id === m.userId)?.email === email), "This person is already on the team.");
        const invitation = { id: id() + id(), projectId: p.id, email, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), accepted: false }; db.invitations.push(invitation); event(p, `${user.name} created a team invitation.`); return NextResponse.json({ token: invitation.id }, { headers });
      }
      ensure(b.revision === p.revision, "This project changed in another session. Reload the latest version before continuing.", 409);
      if (action === "save") {
        ensure(p.state === "draft", "Start a new revision before editing this review.", 409);
        ensure(Array.isArray(b.panels) && b.panels.length === 4, "A comic needs four panel slots.");
        const panels: Panel[] = b.panels.map((raw) => { ensure(raw && typeof raw === "object", "Invalid panel."); const panel = raw as Record<string, unknown>; const image = text(panel.image, 3_500_000, "Panel image", false); ensure(!image || /^\/art\/(space|ramen|garden)\.svg(#panel-[0-3])?$/.test(image) || /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image), "Use a valid PNG or JPEG image."); if (image.startsWith("data:")) { const bytes = Buffer.from(image.split(",")[1], "base64"); ensure((bytes[0] === 0xff && bytes[1] === 0xd8) || (bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === "PNG"), "Invalid image file."); } return { image, dialogue: text(panel.dialogue, 2000, "Dialogue", false), alt: text(panel.alt, 500, "Image description", false) }; });
        p.panels = panels;
        if (owner) {
          p.title = text(b.title, 80, "Title"); p.description = text(b.description, 1000, "Description", false); p.terms = text(b.terms, 3000, "Use terms");
          ensure(Array.isArray(b.members) && b.members.length === p.members.length, "The team has changed. Reload first.", 409);
          p.members = p.members.map(m => { const candidate = (b.members as Record<string, unknown>[]).find(c => c.userId === m.userId); ensure(candidate && Number.isInteger(candidate.share) && Number(candidate.share) >= 0 && Number(candidate.share) <= 10000, "Shares must be between 0 and 100% with up to two decimal places."); return { ...m, role: text(candidate.role, 60, "Role"), share: Number(candidate.share) }; });
        }
        event(p, `${user.name} saved the comic.`);
      } else if (action === "review") {
        ensure(owner && p.state === "draft", "Only the owner can start a review from a draft.", 403);
        ensure(!db.invitations.some(i => i.projectId === p.id && !i.accepted && Date.parse(i.expiresAt) > Date.now()), "Your team has pending invitations. Wait for everyone to join before freezing the roster.");
        ensure(p.panels.every(panel => panel.image && panel.alt), "Add artwork and an image description to all four panels.");
        ensure(p.members.every(m => m.share > 0) && p.members.reduce((s, m) => s + m.share, 0) === 10000, "Give every contributor a positive share, totaling exactly 100%.");
        p.state = "review"; p.rosterFrozen = true; p.version++; p.approvals = []; event(p, `${user.name} froze version ${p.version} for everyone's review.`);
      } else if (action === "revise") { ensure(owner && p.state === "review", "Only the owner can reopen a review.", 403); p.state = "draft"; p.approvals = []; event(p, `${user.name} reopened the draft. Earlier approvals were cleared.`);
      } else if (action === "approve" || action === "revoke") { ensure(p.state === "review", "This comic isn't awaiting review.", 409); p.approvals = p.approvals.filter(u => u !== user.id); if (action === "approve") p.approvals.push(user.id); event(p, `${user.name} ${action === "approve" ? "approved" : "revoked approval for"} version ${p.version}.`);
      } else if (action === "publish") { ensure(owner && p.state === "review" && p.members.every(m => p.approvals.includes(m.userId)), "Every contributor must approve this version before the owner can publish.", 403); p.state = "published"; p.publishedAt = new Date().toISOString(); event(p, `${user.name} published this comic with everyone's approval.`);
      } else throw new AppError("Unknown action.");
      p.revision++; return NextResponse.json({ ok: true, id: p.id }, { headers });
    }, true);
  } catch (error) { return errorResponse(error); }
}
function newProject(ownerId: string, name: string, title: string, description: string, theme: string): Project {
  const now = new Date().toISOString(); return { id: id(), ownerId, title, description, theme, genre: "Original comic", members: [{ userId: ownerId, name, role: "Creator", share: 10000 }], panels: Array.from({ length: 4 }, () => ({ image: "", dialogue: "", alt: "" })), state: "draft", revision: 1, version: 0, approvals: [], terms: "Personal reading and sharing a link are welcome. Artwork belongs to its creators. Commercial reuse requires permission from all contributors.", rosterFrozen: false, createdAt: now, updatedAt: now, events: [{ id: id(), text: `${name} started a new story.`, at: now }] };
}
