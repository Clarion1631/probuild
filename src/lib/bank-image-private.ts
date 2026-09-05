import { createHash } from "node:crypto";
import sharp from "sharp";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const MIN_IMAGE_BYTES = 5_000;
const BANK_REFERENCE = /^\d{12,20}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_IMAGE_PIXELS = 25_000_000;

type ManifestFile = {
    fileName?: unknown;
    side?: unknown;
    byteSize?: unknown;
    sha256?: unknown;
};

type ManifestEntry = {
    bankReference?: unknown;
    kind?: unknown;
    direction?: unknown;
    micrRedacted?: unknown;
    checkNumber?: unknown;
    date?: unknown;
    amountCents?: unknown;
    capturedAt?: unknown;
    redactionReview?: unknown;
    files?: unknown;
};

export type PrivateBankImageRow = {
    kind: "CHECK_FRONT" | "DEPOSIT_PHOTO";
    source: string;
    sourceExternalId: string;
    account: string;
    capturedAt: Date;
    documentDate: Date | null;
    fileName: string;
    mime: string;
    byteSize: number | null;
    normalizedCheckNumber: string | null;
    amountCents: number | null;
};

export type PreparedPrivateBankImage = {
    ok: true;
    row: PrivateBankImageRow;
    storagePath: string;
    secureRef: string;
    sha256: string;
    storageMetadata: Record<string, string>;
};

export type RejectedPrivateBankImage = { ok: false; reason: string };

function dateOnly(value: unknown): Date | null {
    if (typeof value !== "string") return null;
    const text = value.trim();
    const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    const normalized = us ? `${us[3]}-${us[1]}-${us[2]}` : iso ? text : null;
    if (!normalized) return null;
    const result = new Date(`${normalized}T00:00:00.000Z`);
    return Number.isNaN(result.getTime()) || result.toISOString().slice(0, 10) !== normalized ? null : result;
}

function normalizedCheckNumber(value: unknown): string | null {
    const digits = String(value ?? "").replace(/\D/g, "").replace(/^0+/, "");
    return digits || null;
}

function validCapturedAt(value: unknown): Date | null {
    if (typeof value !== "string") return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function verifiedRedactionMetadata(value: unknown, decodedWidth: number, decodedHeight: number): Record<string, string> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const review = value as Record<string, unknown>;
    const nonBlank = (field: string) => typeof review[field] === "string" && review[field].trim().length > 0;
    const reviewedAt = typeof review.reviewedAt === "string" ? new Date(review.reviewedAt) : null;
    const cropBox = Array.isArray(review.cropBox) ? review.cropBox : [];
    const dimensions = Array.isArray(review.sourceDimensions) ? review.sourceDimensions : [];
    const [left, top, right, bottom] = cropBox;
    const [sourceWidth, sourceHeight] = dimensions;
    const validCrop = cropBox.length === 4 && cropBox.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
        && dimensions.length === 2 && dimensions.every((dimension) => typeof dimension === "number" && dimension > 0 && Number.isFinite(dimension))
        && left >= 0 && top >= 0 && right > left && bottom > top && right <= sourceWidth && bottom <= sourceHeight
        && decodedWidth === right - left && decodedHeight === bottom - top;
    const valid = review.status === "passed"
        && nonBlank("method")
        && validCrop
        && typeof review.sourceSha256 === "string" && SHA256.test(review.sourceSha256.toLowerCase())
        && nonBlank("reviewer")
        && !!reviewedAt && !Number.isNaN(reviewedAt.getTime());
    if (!valid) return null;
    return {
        redaction_status: "passed",
        redaction_method: review.method as string,
        redaction_crop_box: JSON.stringify(review.cropBox),
        redaction_source_dimensions: JSON.stringify(review.sourceDimensions),
        redaction_source_sha256: review.sourceSha256 as string,
        redaction_reviewer: review.reviewer as string,
        redaction_reviewed_at: review.reviewedAt as string,
    };
}

/**
 * Validate a previously redacted front and make an immutable, hash-addressed
 * private-storage reference. The image pixels are not inspected for MICR: the
 * caller must supply the redaction attestation after its visual review.
 */
export async function preparePrivateBankImage(entry: ManifestEntry, bytes: Buffer): Promise<PreparedPrivateBankImage | RejectedPrivateBankImage> {
    const reference = typeof entry.bankReference === "string" ? entry.bankReference.trim() : "";
    if (!BANK_REFERENCE.test(reference)) return { ok: false, reason: "bank reference is invalid" };
    const incoming = entry.kind === "DEPOSIT_CHECK";
    if (entry.kind !== "CHECK" && !incoming) return { ok: false, reason: "only CHECK and DEPOSIT_CHECK entries are accepted" };
    if (incoming && entry.direction !== "incoming") return { ok: false, reason: "incoming direction is required" };
    if (entry.micrRedacted !== true) return { ok: false, reason: "MICR redaction attestation is required" };
    if (!incoming && (typeof entry.checkNumber !== "string" || !/^\d+$/.test(entry.checkNumber.trim()) || !normalizedCheckNumber(entry.checkNumber))) return { ok: false, reason: "check number must be digits" };
    if (incoming && entry.checkNumber !== null && entry.checkNumber !== undefined && (typeof entry.checkNumber !== "string" || !/^\d+$/.test(entry.checkNumber.trim()) || !normalizedCheckNumber(entry.checkNumber))) return { ok: false, reason: "incoming check number must be digits when present" };
    if (!Array.isArray(entry.files) || entry.files.length !== 1) return { ok: false, reason: "exactly one front image is required" };
    const file = entry.files[0] as ManifestFile;
    if (file?.side !== "front") return { ok: false, reason: "check backs are not accepted" };
    const fileName = typeof file.fileName === "string" ? file.fileName : "";
    if (!/\.jpe?g$/i.test(fileName) || /[\\/]/.test(fileName)) return { ok: false, reason: "front must have a safe JPEG filename" };
    if (!Buffer.isBuffer(bytes) || bytes.length < MIN_IMAGE_BYTES || !bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
        return { ok: false, reason: "front is not a valid-sized JPEG" };
    }
    try {
        const decoder = sharp(bytes, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS });
        const metadata = await decoder.metadata();
        const decoded = await decoder.raw().toBuffer({ resolveWithObject: true });
        if (metadata.format !== "jpeg" || !decoded.info.width || !decoded.info.height) {
            return { ok: false, reason: "front is not a decodable JPEG" };
        }
        const redactionMetadata = verifiedRedactionMetadata(entry.redactionReview, decoded.info.width, decoded.info.height);
        if (!redactionMetadata) return { ok: false, reason: "verified redaction review is required" };
        const digest = createHash("sha256").update(bytes).digest("hex");
        const declaredHash = typeof file.sha256 === "string" ? file.sha256.toLowerCase() : "";
        if (!SHA256.test(declaredHash) || declaredHash !== digest) return { ok: false, reason: "front hash does not match manifest" };
        if (typeof file.byteSize !== "number" || !Number.isInteger(file.byteSize) || file.byteSize !== bytes.length) return { ok: false, reason: "front byte size does not match manifest" };
        const documentDate = dateOnly(entry.date);
        if (entry.date && !documentDate) return { ok: false, reason: "check date is invalid" };
        const capturedAt = validCapturedAt(entry.capturedAt);
        if (!capturedAt) return { ok: false, reason: "capture timestamp is required" };
        const amountCents = entry.amountCents === undefined || entry.amountCents === null ? null
            : typeof entry.amountCents === "number" && Number.isSafeInteger(entry.amountCents) && entry.amountCents > 0 ? entry.amountCents : null;
        if (entry.amountCents !== undefined && entry.amountCents !== null && amountCents === null) return { ok: false, reason: "check amount must be positive integer cents" };
        const source = incoming ? "WTB_ONLINE_INCOMING" : "WTB_ONLINE";
        const sourceSha = redactionMetadata.redaction_source_sha256.toLowerCase();
        const sourceExternalId = incoming ? `${reference}:image:${sourceSha}:front` : `${reference}:front`;
        const storagePath = incoming
            ? `bank-images/wtb-online-incoming/${reference}/${sourceSha}/front-redacted-${digest}.jpg`
            : `bank-images/wtb-online/${reference}/front-redacted-${digest}.jpg`;
        return { ok: true, row: { kind: incoming ? "DEPOSIT_PHOTO" : "CHECK_FRONT", source, sourceExternalId, account: "WTB-0723", capturedAt, documentDate, fileName, mime: "image/jpeg", byteSize: bytes.length, normalizedCheckNumber: incoming ? null : normalizedCheckNumber(entry.checkNumber), amountCents }, storagePath, secureRef: `secure:${storagePath}`, sha256: digest, storageMetadata: { ...redactionMetadata, redacted_front_sha256: digest, ...(incoming ? { evidence_direction: "incoming", evidence_label: "Incoming check", bank_reference: reference, bank_original_sha256: sourceSha } : {}) } };
    } catch {
        return { ok: false, reason: "front is not a decodable JPEG" };
    }
}
