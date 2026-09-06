import { NextRequest, NextResponse } from "next/server";

import { isValidBankImageIngestKey } from "@/lib/bank-image-auth";
import { ingestPreparedBankImage } from "@/lib/bank-image-ingest";
import { preparePrivateBankImage } from "@/lib/bank-image-private";
import { prisma } from "@/lib/prisma";
import { SECURE_BUCKET } from "@/lib/secure-storage";
import { getSupabase } from "@/lib/supabase";

export const maxDuration = 30;

// The hosted API request limit applies before this handler. One modest JPEG per
// request lets the client stream a historical batch without relying on a large
// base64 request body.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function authorized(request: NextRequest): boolean {
    return isValidBankImageIngestKey(request.headers.get("x-ingest-key"), process.env.BANK_IMAGE_INGEST_SECRET);
}

function decodeImage(value: unknown): Buffer | null {
    if (typeof value !== "string" || !value || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16) return null;
    try {
        const result = Buffer.from(value, "base64");
        return result.length > 0 && result.length <= MAX_IMAGE_BYTES ? result : null;
    } catch {
        return null;
    }
}

/** Server-side storage + metadata writer for visually verified check fronts. */
export async function POST(request: NextRequest) {
    if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const body = await request.json().catch(() => null) as { items?: unknown } | null;
    if (!body || !Array.isArray(body.items) || body.items.length !== 1) {
        return NextResponse.json({ error: "items must contain exactly one front" }, { status: 400 });
    }
    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: "private storage is not configured" }, { status: 503 });

    const results: Array<{ sourceExternalId?: string; status: "created" | "backfilled" | "existing" | "rejected"; reason?: string }> = [];
    for (const item of body.items) {
        const record = item as Record<string, unknown>;
        const imageBytes = decodeImage(record?.imageBase64);
        if (!imageBytes) {
            results.push({ status: "rejected", reason: "front image payload is invalid" });
            continue;
        }
        const prepared = await preparePrivateBankImage(record, imageBytes);
        if (!prepared.ok) {
            results.push({ status: "rejected", reason: prepared.reason });
            continue;
        }
        const result = await ingestPreparedBankImage(prepared, imageBytes, {
            find: async (source, sourceExternalId) => {
                const found = await prisma.bankImage.findUnique({
                    where: { source_sourceExternalId: { source, sourceExternalId } },
                    select: { id: true, kind: true, source: true, sourceExternalId: true, account: true, capturedAt: true, documentDate: true, fileName: true, mime: true, byteSize: true, normalizedCheckNumber: true, amountCents: true, driveFileId: true },
                });
                return found ? { ...found } : null;
            },
            backfill: async (id, secureRef) => (await prisma.bankImage.updateMany({ where: { id, driveFileId: null }, data: { driveFileId: secureRef } })).count === 1,
            create: async (row, secureRef) => { await prisma.bankImage.create({ data: { ...row, driveFileId: secureRef } }); },
        }, {
            upload: async (path, bytes, metadata) => ({ error: !!(await supabase.storage.from(SECURE_BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: false, metadata })).error }),
            download: async (path) => {
                const response = await supabase.storage.from(SECURE_BUCKET).download(path);
                return response.data ? Buffer.from(await response.data.arrayBuffer()) : null;
            },
        });
        results.push({ sourceExternalId: prepared.row.sourceExternalId, ...result });
    }
    return NextResponse.json({ results });
}
