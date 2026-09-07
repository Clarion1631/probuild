import { createHash, createHmac } from "node:crypto";
import { isValidBankImageIngestKey } from "./bank-image-auth";
import type { PreparedPrivateBankImage, PrivateBankImageRow, RejectedPrivateBankImage } from "./bank-image-private";
import type { PrivateImageStorage } from "./bank-image-ingest";

const HASH = "c6c6b519a214b8d82a2619ca694465fd9813e0fe521751e87feedf6fe2695432";
const SOURCE_HASH = "591feb1fcbed8ac9d0611935b18d5a7e9538a42029a2e94dad3e06e6a560553b";
const REPAIR_ID = "wtb-check-1027-redacted-front-v2-preserve-ocr";
export const LEGACY_1027 = {
    source: "WTB_ONLINE", sourceExternalId: "26225018006376:front", kind: "CHECK_FRONT", account: "WTB-0723",
    documentDate: "2026-08-13", fileName: "08-13-2026_CHECK_6037.15_26225018006376_front.jpg",
    mime: "image/jpeg", byteSize: 174152, normalizedCheckNumber: "1027", amountCents: null, driveFileId: null,
};
export const LEGACY_1027_EXTRACTION = {
    payerName: "GOLDEN TOUCH RMEODELING LLC", memoText: "HOPPE VANITY CONTRACT 4152",
    extractionModel: "gemini-3-flash-preview",
};
const LEGACY_EXACT = {
    capturedAtExact: "2026-08-19T10:12:41.451000Z",
    updatedAtExact: "2026-08-28T20:45:46.494000Z",
    extractedAtExact: "2026-08-22T08:13:57.755670Z",
};
export const REPLACEMENT_1027 = {
    source: LEGACY_1027.source, sourceExternalId: LEGACY_1027.sourceExternalId, kind: "CHECK_FRONT", account: "WTB-0723",
    documentDate: "2026-08-13", capturedAt: "2026-09-05T05:15:37.513Z",
    fileName: "WTB_2026-08-13_check-1027_26225018006376_front.jpg",
    mime: "image/jpeg", byteSize: 239348, normalizedCheckNumber: "1027", amountCents: 603715,
};
// PostgreSQL JSON retains timestamps to microsecond precision; never round-trip
// these snapshots through JS Date before comparison, token generation, or audit.
export type RepairSnapshot = { row: Record<string, unknown>; capturedAtExact: string; updatedAtExact: string; extractedAtExact: string | null; matchCount: number };
export type RepairTransaction = {
    lock(): Promise<RepairSnapshot | null>;
    replace(before: RepairSnapshot, next: PrivateBankImageRow, secureRef: string): Promise<Record<string, unknown>>;
    audit(snapshot: Record<string, unknown>): Promise<void>;
};
type Dependencies = {
    secret(): string | undefined;
    prepare(item: Record<string, unknown>, bytes: Buffer): Promise<PreparedPrivateBankImage | RejectedPrivateBankImage>;
    transaction<T>(run: (tx: RepairTransaction) => Promise<T>): Promise<T>;
    verifyStorage(prepared: PreparedPrivateBankImage, bytes: Buffer): Promise<void>;
};
function json(body: unknown, status = 200) { return Response.json(body, { status, headers: { "cache-control": "private, no-store" } }); }
function stable(value: unknown): string {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
    return JSON.stringify(value);
}
function legacyMismatch(s: RepairSnapshot): string[] {
    const fields = Object.entries(LEGACY_1027).filter(([k,v]) => s.row[k] !== v).map(([k]) => k);
    for (const [field, expected] of Object.entries(LEGACY_EXACT)) if (s[field as keyof typeof LEGACY_EXACT] !== expected) fields.push(field);
    if (s.matchCount !== 0) fields.push("matches");
    for (const [field, expected] of Object.entries(LEGACY_1027_EXTRACTION)) if (s.row[field] !== expected) fields.push(field);
    if (typeof s.row.id !== "string" || !s.row.id) fields.push("id");
    return fields;
}
function allowedReplacement(p: PreparedPrivateBankImage): boolean {
    const row = { ...p.row, capturedAt: p.row.capturedAt.toISOString(), documentDate: p.row.documentDate?.toISOString().slice(0,10) };
    return Object.entries(REPLACEMENT_1027).every(([k,v]) => row[k as keyof typeof row] === v)
        && p.sha256 === HASH && p.storageMetadata.redaction_source_sha256.toLowerCase() === SOURCE_HASH
        && p.storagePath === `bank-images/wtb-online/26225018006376/front-redacted-${HASH}.jpg`
        && p.secureRef === `secure:${p.storagePath}`;
}
export async function verifyRepairStorage(p: PreparedPrivateBankImage, bytes: Buffer, storage: PrivateImageStorage): Promise<void> {
    await storage.upload(p.storagePath, bytes, p.storageMetadata);
    const stored = await storage.download(p.storagePath);
    if (!stored || createHash("sha256").update(stored).digest("hex") !== p.sha256) throw Error("private object verification failed");
}

/** One incident only. A repair request is never an ordinary ingest fallback. */
export function createBankImage1027RepairHandler(deps: Dependencies) {
    return async function POST(request: Request): Promise<Response> {
        const secret = deps.secret();
        if (!isValidBankImageIngestKey(request.headers.get("x-ingest-key"), secret)) return json({ error: "unauthorized" }, 401);
        if (request.method !== "POST" || new URL(request.url).search) return json({ error: "unsupported request" }, 400);
        const body = await request.json().catch(() => null);
        if (!body || !["dry-run", "commit"].includes(body.mode) || !body.item || typeof body.item !== "object") return json({ error: "mode and one reviewed item are required" }, 400);
        const base64 = body.item.imageBase64;
        if (typeof base64 !== "string" || !base64 || base64.length > 400_000) return json({ error: "invalid front payload" }, 400);
        try {
            const bytes = Buffer.from(base64, "base64");
            const prepared = await deps.prepare(body.item, bytes);
            if (!prepared.ok || !allowedReplacement(prepared)) return json({ error: "front is outside the reviewed repair" }, 400);
            return await deps.transaction(async tx => {
                const before = await tx.lock();
                if (!before) return json({ error: "legacy image not found" }, 409);
                const mismatches = legacyMismatch(before);
                if (mismatches.length) return json({ error: "legacy state differs; no repair performed", mismatches, capturedAtExact: before.capturedAtExact }, 409);
                const token = createHmac("sha256", secret!).update(stable({ repairId: REPAIR_ID, before, replacement: prepared.row, hash: HASH, redactionReview: prepared.storageMetadata })).digest("hex");
                if (body.mode === "dry-run") return json({ status: "ready", repairId: REPAIR_ID, before: { ...LEGACY_1027, ...LEGACY_1027_EXTRACTION, ...LEGACY_EXACT }, after: { ...REPLACEMENT_1027, ...LEGACY_1027_EXTRACTION, extractedAtExact: before.extractedAtExact }, sha256: HASH, preflightToken: token });
                if (!isValidBankImageIngestKey(body.preflightToken, token)) return json({ error: "fresh dry-run preflight token required" }, 409);
                await deps.verifyStorage(prepared, bytes);
                const after = await tx.replace(before, prepared.row, prepared.secureRef);
                await tx.audit({ repairId: REPAIR_ID, credentialLabel: "BANK_IMAGE_INGEST_SECRET", actorType: "machine-credential", before: before.row, after, sha256: HASH, redactionReview: prepared.storageMetadata });
                return json({ status: "repaired", repairId: REPAIR_ID, sha256: HASH });
            });
        } catch {
            return json({ error: "repair failed; metadata transaction rolled back; verified private object may remain for retry" }, 503);
        }
    };
}
