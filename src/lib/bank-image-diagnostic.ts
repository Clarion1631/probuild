import { isValidBankImageIngestKey } from "./bank-image-auth";
import type { StoredBankImage } from "./bank-image-ingest";

// Incident scope only. Expanding access requires another reviewed code change.
const BANK_REFERENCE = "26225018006376";
const SOURCE = "WTB_ONLINE";
const PRIVATE_FRONT = new RegExp(`^secure:(bank-images/wtb-online/${BANK_REFERENCE}/front-redacted-[a-f0-9]{64}\\.jpg)$`);

export type BankImageDiagnosticRow = Omit<StoredBankImage, "id">;
export type StoragePresence = "present" | "missing" | "unavailable";
type Dependencies = {
    secret(): string | undefined;
    find(source: string, sourceExternalId: string): Promise<BankImageDiagnosticRow | null>;
    storagePresence(path: string): Promise<StoragePresence>;
};

function json(body: unknown, status = 200) {
    return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
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
            // Explicit projection: never return the stored link, OCR, internal ID,
            // image bytes, storage path, or backend error text.
            return json({
                metadata: {
                    kind: row.kind, source: row.source, sourceExternalId: row.sourceExternalId,
                    account: row.account, capturedAt: row.capturedAt.toISOString(),
                    documentDate: row.documentDate?.toISOString() ?? null,
                    fileName: row.fileName, mime: row.mime, byteSize: row.byteSize,
                    normalizedCheckNumber: row.normalizedCheckNumber, amountCents: row.amountCents,
                },
                storage: { referenceKind, presence },
            });
        } catch {
            return json({ error: "bank image diagnostic unavailable" }, 503);
        }
    };
}
