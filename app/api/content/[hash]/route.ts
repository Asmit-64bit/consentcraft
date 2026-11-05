import { loadContent } from "@/lib/contracts/storage";
import { AppError } from "@/lib/store";

export async function GET(_request: Request, context: { params: Promise<{ hash: string }> }) {
  try {
    const { hash } = await context.params;
    const { bytes, mime } = await loadContent(hash);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'", ETag: `"${hash}"` } });
  } catch (error) { return Response.json({ error: error instanceof AppError ? error.message : "Content unavailable." }, { status: error instanceof AppError ? error.status : 500 }); }
}
