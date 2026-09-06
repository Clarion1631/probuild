import { isValidBankImageIngestKey } from "./bank-image-auth";
import type { StoredBankImage } from "./bank-image-ingest";

// Incident scope only. Expanding access requires another reviewed code change.
const BANK_REFERENCE = "26225018006376";
const SOURCE = "WTB_ONLINE";
const PRIVATE_FRONT = new RegExp(`^secure:(bank-images/wtb-online/${BANK_REFERENCE}/front-redacted-[a-f0-9]{64}\\.jpg)$`);

export type BankImageDiagnosticEvidence = {
    capturedAtExact: string;
    updatedAtExact: string;
    payerName: string | null;
    memoText: string | null;
    extractedAtExact: string | null;
    extractionModel: string | null;
    matchCount: number;
};
export type BankImageDiagnosticRow = Omit<StoredBankImage, "id"> & { evidence: BankImageDiagnosticEvidence };
export type StoragePresence = "present" | "missing" | "unavailable";
type Dependencies = {
    secret(): string | undefined;
    find(source: string, sourceExternalId: string): Promise<BankImageDiagnosticRow | null>;
    storagePresence(path: string): Promise<StoragePresence>;
};

function json(body: unknown, status = 200) {
    return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

function evidenceProjection(evidence: BankImageDiagnosticEvidence) {
    const withheldFields: string[] = [];
    const safeText = (field: "payerName" | "memoText" | "extractionModel") => {
        const value = evidence[field];
        // Existing OCR is normally scrubbed at ingestion. This read projection
        // also withholds suspicious text; it never rewrites the stored evidence.
        // Same plausible-date exemptions and MICR boundary as scrubField in
        // scripts/extract-check-payers.mjs. Count all remaining digits (even
        // across separators); never normalize the evidence returned to callers.
        const dateless = value?.replace(/\b(?:19|20)\d{2}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])\b/g, " ")
            .replace(/\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)?\d{2}\b/g, " ");
        if (value && ((dateless?.replace(/\D/g, "").length ?? 0) >= 8 || /[\u2446\u2447\u2448\u2449]/.test(value)
            || /https?:\/\//i.test(value) || value.length > 500)) {
            withheldFields.push(field);
            return null;
        }
        return value;
    };
    return {
        capturedAtExact: evidence.capturedAtExact, updatedAtExact: evidence.updatedAtExact,
        payerName: safeText("payerName"), memoText: safeText("memoText"),
        extractedAtExact: evidence.extractedAtExact, extractionModel: safeText("extractionModel"),
        matchCount: evidence.matchCount, withheldFields,
    };
}

/** A read-only incident diagnostic. No caller-selected source, ID, or storage path. */
export function createBankImageDiagnosticHandler(deps: Dependencies) {
    return async function GET(request: Request): Promise<Response> {
        if (!isValidBankImageIngestKey(request.headers.get("x-ingest-key"), deps.secret())) {
            return json({ error: "unauthorized" }, 401);
        }
        if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
        const params = new URL(request.url).searchParams;
        if (Array.from(params).length !== 1 || params.get("bankReference") !== BANK_REFERENCE) {
            return json({ error: "unsupported bank reference" }, 400);
        }
        try {
            const row = await deps.find(SOURCE, `${BANK_REFERENCE}:front`);
            if (!row) return json({ error: "bank image not found" }, 404);
            const match = row.driveFileId?.match(PRIVATE_FRONT);
            const referenceKind = !row.driveFileId ? "none" : match ? "private"
                : row.driveFileId.startsWith("secure:") ? "invalid_private" : "legacy";
            let presence: StoragePresence | "not_checked" = "not_checked";
            if (match) {
                try { presence = await deps.storagePresence(match[1]); }
                catch { presence = "unavailable"; }
            }
            // Explicit projection: never return stored links, unselected OCR,
            // internal IDs, image bytes, storage paths, or backend error text.
            return json({
                metadata: {
                    kind: row.kind, source: row.source, sourceExternalId: row.sourceExternalId,
                    account: row.account, capturedAt: row.capturedAt.toISOString(),
                    documentDate: row.documentDate?.toISOString() ?? null,
                    fileName: row.fileName, mime: row.mime, byteSize: row.byteSize,
                    normalizedCheckNumber: row.normalizedCheckNumber, amountCents: row.amountCents,
                },
                storage: { referenceKind, presence },
                evidence: evidenceProjection(row.evidence),
            });
        } catch {
            return json({ error: "bank image diagnostic unavailable" }, 503);
        }
    };
}
