import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import Anthropic from "@anthropic-ai/sdk";
import { authenticateMobileOrSession, userCanAccessProject } from "@/lib/mobile-auth";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";
import { withReceiptEvidenceLock } from "@/lib/receipt-evidence-lock";

const RECEIPT_PROMPT = `You are an AI receipt parser for a construction company.
Analyze this receipt image and extract the following information as JSON:

{
  "vendor": "Store or vendor name",
  "date": "YYYY-MM-DD or null if unclear",
  "total": 0.00,
  "subtotal": 0.00,
  "tax": 0.00,
  "items": [
    { "description": "Item name", "quantity": 1, "unitPrice": 0.00, "total": 0.00 }
  ],
  "category": "Materials | Labor | Equipment | Subcontractor | Other",
  "confidence": 0.95,
  "notes": "Any additional notes or caveats"
}

Return ONLY valid JSON, no markdown, no explanation.`;

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const EXT_BY_MIME: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
};

// Derive the image type from the file's magic bytes — the client-claimed `file.type`
// is attacker-controlled and this upload lands in a public bucket. Returns null for
// anything that isn't one of the four supported formats (including empty files).
function sniffImageMime(buf: Buffer): keyof typeof EXT_BY_MIME | null {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
    if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    return null;
}
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024; // 10 MB
const RECEIPT_FETCH_TIMEOUT_MS = 8_000;

// SSRF defense: only fetch URLs from Supabase storage. Anything else (link-local IPs,
// internal services, attacker-controlled hosts) is rejected up front. The web UI passes
// `imageBase64`; mobile passes `receiptUrl` after uploading to our signed storage URL.
function isAllowedReceiptHost(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:") return false;
    // Supabase project storage hostnames look like `<ref>.supabase.co`.
    // We allow the configured project + any *.supabase.co host (cross-project storage
    // shares the same auth model). If you want to lock this down further, set
    // `RECEIPT_ALLOWED_HOST` to an exact hostname in env.
    const allowedExact = process.env.RECEIPT_ALLOWED_HOST?.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    if (allowedExact) return host === allowedExact;
    return host === "supabase.co" || host.endsWith(".supabase.co");
}

// Hybrid auth (web + mobile). Three input modes:
//   1. multipart/form-data with `file` field            (web upload)
//   2. JSON `{ imageBase64, mimeType, projectId? }`     (web inline / dev)
//   3. JSON `{ receiptUrl, projectId? }`                (mobile — uploaded to Supabase
//                                                        first, then references the URL)
// In mode 3 the server fetches the bytes itself so the model receives base64 either way.
export async function POST(req: NextRequest) {
    // Track the uploaded storage object outside the try block so failure paths
    // (missing API key, AI errors) can delete it instead of orphaning it in the bucket.
    let storagePath: string | null = null;
    const cleanupUpload = async () => {
        if (!storagePath) return;
        const sb = getSupabase();
        if (sb) {
            try { await sb.storage.from(STORAGE_BUCKET).remove([storagePath]); } catch { /* best effort */ }
        }
        storagePath = null;
    };
    try {
        const auth = await authenticateMobileOrSession(req);
        if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
        const { user } = auth;

        const contentType = req.headers.get("content-type") || "";

        let imageBase64: string | null = null;
        let mimeType = "image/jpeg";
        let projectId: string | null = null;
        let receiptUrl: string | null = null;
        let storageError: string | null = null;

        if (contentType.includes("multipart/form-data")) {
            const formData = await req.formData();
            const file = formData.get("file") as File | null;
            projectId = (formData.get("projectId") as string) || null;
            if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
            if (file.size > MAX_RECEIPT_BYTES) {
                return NextResponse.json(
                    { error: `Receipt image too large (>${MAX_RECEIPT_BYTES} bytes)` },
                    { status: 400 }
                );
            }
            const buffer = Buffer.from(await file.arrayBuffer());
            const sniffedMime = sniffImageMime(buffer);
            if (!sniffedMime) {
                return NextResponse.json(
                    { error: "Unsupported receipt image type. Use JPEG, PNG, GIF, or WebP." },
                    { status: 400 }
                );
            }
            imageBase64 = buffer.toString("base64");
            mimeType = sniffedMime;

            // Persist the original to Supabase Storage so the expense can link to a
            // durable receipt image (the old /api/expenses/parse wrote into `public/`,
            // which is read-only and non-durable on Vercel). Storage failure is not
            // fatal — parsing is the primary job — but it is surfaced to the caller.
            const supabase = getSupabase();
            if (supabase) {
                const candidate = `receipts/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${EXT_BY_MIME[mimeType]}`;
                const { error: uploadError } = await supabase.storage
                    .from(STORAGE_BUCKET)
                    .upload(candidate, buffer, { contentType: mimeType, upsert: false });
                if (uploadError) {
                    storageError = uploadError.message;
                } else {
                    storagePath = candidate;
                    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(candidate);
                    receiptUrl = urlData.publicUrl;
                }
            } else {
                storageError = "Storage not configured";
            }
        } else {
            const body = await req.json();
            projectId = body.projectId || null;
            if (typeof body.receiptUrl === "string" && body.receiptUrl) {
                if (!isAllowedReceiptHost(body.receiptUrl)) {
                    return NextResponse.json(
                        { error: "receiptUrl host not allowed" },
                        { status: 400 }
                    );
                }
                // Time-bound the download. Vercel's function timeout is the outer limit;
                // a faster local timeout makes a slow link fail fast and frees the slot.
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), RECEIPT_FETCH_TIMEOUT_MS);
                let fetched: Response;
                try {
                    // `redirect: "manual"` so an attacker can't smuggle a redirect to a
                    // disallowed host through an allowed one.
                    fetched = await fetch(body.receiptUrl, {
                        redirect: "manual",
                        signal: controller.signal,
                    });
                } catch (err) {
                    clearTimeout(timer);
                    return NextResponse.json(
                        { error: err instanceof Error ? err.message : "Receipt fetch failed" },
                        { status: 400 }
                    );
                }
                clearTimeout(timer);
                if (!fetched.ok) {
                    return NextResponse.json(
                        { error: `Failed to fetch receiptUrl (${fetched.status})` },
                        { status: 400 }
                    );
                }
                // Pre-flight via Content-Length AND stream-cap during read. Content-Length
                // is best-effort (servers can omit or lie about it); the stream cap is the
                // real defense — we abort the read once we've seen MAX_RECEIPT_BYTES so a
                // malicious server can't OOM us by withholding Content-Length.
                const declared = Number.parseInt(fetched.headers.get("content-length") ?? "-1", 10);
                if (declared > MAX_RECEIPT_BYTES) {
                    return NextResponse.json(
                        { error: `Receipt image too large (>${MAX_RECEIPT_BYTES} bytes)` },
                        { status: 400 }
                    );
                }
                const ct = fetched.headers.get("content-type") || "image/jpeg";
                mimeType = ct.split(";")[0].trim();

                const reader = fetched.body?.getReader();
                if (!reader) {
                    return NextResponse.json({ error: "Receipt response has no body" }, { status: 400 });
                }
                const chunks: Uint8Array[] = [];
                let total = 0;
                let oversized = false;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) {
                        total += value.byteLength;
                        if (total > MAX_RECEIPT_BYTES) {
                            oversized = true;
                            await reader.cancel();
                            break;
                        }
                        chunks.push(value);
                    }
                }
                if (oversized) {
                    return NextResponse.json(
                        { error: `Receipt image too large (>${MAX_RECEIPT_BYTES} bytes)` },
                        { status: 400 }
                    );
                }
                imageBase64 = Buffer.concat(chunks).toString("base64");
            } else if (typeof body.imageBase64 === "string") {
                imageBase64 = body.imageBase64;
                mimeType = body.mimeType || "image/jpeg";
            }
        }

        if (!imageBase64) {
            return NextResponse.json(
                { error: "Provide either a `file`, `imageBase64`, or `receiptUrl`" },
                { status: 400 }
            );
        }

        if (!process.env.ANTHROPIC_API_KEY) {
            await cleanupUpload();
            return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
        }

        const safeMime = (ALLOWED_MIME.has(mimeType) ? mimeType : "image/jpeg") as
            | "image/jpeg"
            | "image/png"
            | "image/gif"
            | "image/webp";

        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const result = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "image", source: { type: "base64", media_type: safeMime, data: imageBase64 } },
                        { type: "text", text: RECEIPT_PROMPT },
                    ],
                },
            ],
        });

        const text = (result.content[0] as { type: "text"; text: string }).text.trim();
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(text);
        } catch {
            await cleanupUpload();
            return NextResponse.json({ error: "AI returned invalid JSON", raw: text }, { status: 500 });
        }

        // Optional: auto-create a pending expense if projectId provided AND the parse
        // came back with usable vendor + total. We need an estimate to attach to.
        // Always tell the caller whether the expense was created and why not, so a
        // mobile UI can show the right toast (vs silently assuming success).
        let expenseCreated = false;
        let expenseId: string | undefined;
        let expenseSkipReason: "no-project" | "forbidden" | "no-estimate" | "incomplete-parse" | undefined;

        if (!projectId) {
            expenseSkipReason = "no-project";
        } else if (!parsed.vendor || typeof parsed.total !== "number") {
            expenseSkipReason = "incomplete-parse";
        } else if (!(await userCanAccessProject(user, projectId))) {
            expenseSkipReason = "forbidden";
        } else {
            const estimate = await prisma.estimate.findFirst({
                where: { projectId },
                orderBy: { createdAt: "desc" },
                select: { id: true },
            });
            if (!estimate) {
                expenseSkipReason = "no-estimate";
            } else {
                const confidence = ((parsed.confidence as number || 0) * 100).toFixed(0);
                // Same rule: this row lands with its receipt attached
                // (round-42 gate, finding 1).
                const expense = await withReceiptEvidenceLock<{ id: string }>(
                    fn => prisma.$transaction(fn),
                    tx => tx.expense.create({
                    data: {
                        estimateId: estimate.id,
                        description: `[AI ${confidence}%] ${parsed.vendor} receipt — pending bookkeeper review`,
                        amount: parsed.total as number,
                        date: parsed.date ? new Date(parsed.date as string) : new Date(),
                        vendor: parsed.vendor as string,
                        status: "Pending",
                    },
                    select: { id: true },
                }),
                );
                expenseCreated = true;
                expenseId = expense.id;
            }
        }

        // Mobile expects flat fields it can drop into the form.
        return NextResponse.json({
            success: true,
            vendor: parsed.vendor ?? undefined,
            amount: typeof parsed.total === "number" ? parsed.total : undefined,
            date: typeof parsed.date === "string" ? parsed.date : undefined,
            parsed,
            ...(receiptUrl ? { receiptUrl } : {}),
            ...(storageError ? { storageError } : {}),
            expenseCreated,
            ...(expenseId ? { expenseId } : {}),
            ...(expenseSkipReason ? { expenseSkipReason } : {}),
        });
    } catch (err) {
        await cleanupUpload();
        const msg = err instanceof Error ? err.message : "Parse failed";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
