import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { chainConfig, requireChain, trackTransaction } from "@/lib/contracts/server";
import { AppError, database, ensure, sessionUser } from "@/lib/store";

export async function GET() {
  const config = await chainConfig();
  try { await requireChain(); } catch (error) { config.error = error instanceof AppError ? error.message : "Ethereum RPC is unavailable. Start the local node or check your RPC configuration."; }
  return NextResponse.json(config, { headers: { "Cache-Control": "no-store" } });
}

const transactionSchema = z.object({ id: z.string().min(1).max(80), hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/), replaces: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional() });
export async function POST(request: NextRequest) {
  try {
    const host = request.headers.get("host"); const origin = request.headers.get("origin");
    ensure(host && (origin === `http://${host}` || origin === `https://${host}`), "Request origin is not allowed.", 403);
    const raw = await request.text(); ensure(raw.length < 1000, "Invalid transaction request.");
    const result = transactionSchema.safeParse(JSON.parse(raw)); ensure(result.success, "Invalid transaction hash or project.");
    await database(async db => {
      const user = sessionUser(db, request.cookies.get("cc_session")?.value);
      ensure(user?.address, "Sign in with the wallet that sent this transaction.", 401);
      const p = db.projects.find(p => p.id === result.data.id);
      ensure(p && (p.state === "published" || p.members.some(m => m.userId === user.id)), "Project not found.", 404);
      await trackTransaction(p, user.address, result.data.hash as `0x${string}`, result.data.replaces as `0x${string}` | undefined);
    }, true);
    return NextResponse.json({ ok: true });
  } catch (error) { return NextResponse.json({ error: error instanceof AppError ? error.message : "Could not record this transaction yet. Keep its hash and retry reconciliation." }, { status: error instanceof AppError ? error.status : 503 }); }
}
