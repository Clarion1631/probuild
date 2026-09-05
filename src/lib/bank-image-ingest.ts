import { createHash } from "node:crypto";

import type { PreparedPrivateBankImage, PrivateBankImageRow } from "./bank-image-private";

export type StoredBankImage = Omit<PrivateBankImageRow, "kind"> & { id: string; kind: string; driveFileId: string | null };
export type IngestResult = { status: "created" | "backfilled" | "existing" | "rejected"; reason?: string };

export type BankImageRepository = {
    find(source: string, sourceExternalId: string): Promise<StoredBankImage | null>;
    backfill(id: string, secureRef: string): Promise<boolean>;
    create(row: PrivateBankImageRow, secureRef: string): Promise<void>;
};

export type PrivateImageStorage = {
    upload(path: string, bytes: Buffer, metadata: Record<string, string>): Promise<{ error: boolean }>;
    download(path: string): Promise<Buffer | null>;
};

function sameDate(left: Date | null, right: Date | null): boolean {
    return left?.getTime() === right?.getTime();
}

export function hasSameImmutableMetadata(existing: StoredBankImage, row: PrivateBankImageRow): boolean {
    return existing.kind === row.kind
        && existing.source === row.source
        && existing.sourceExternalId === row.sourceExternalId
        && existing.account === row.account
        && sameDate(existing.capturedAt, row.capturedAt)
        && sameDate(existing.documentDate, row.documentDate)
        && existing.fileName === row.fileName
        && existing.mime === row.mime
        && existing.byteSize === row.byteSize
        && existing.normalizedCheckNumber === row.normalizedCheckNumber
        && existing.amountCents === row.amountCents;
}

function isP2002(error: unknown): boolean {
    return !!error && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

async function storedHashMatches(prepared: PreparedPrivateBankImage, storage: PrivateImageStorage): Promise<boolean> {
    const stored = await storage.download(prepared.storagePath);
    return !!stored && createHash("sha256").update(stored).digest("hex") === prepared.sha256;
}

/**
 * Replay-safe state machine for the API route. A failed metadata write leaves a
 * deterministic, hash-addressed private object in place: a later identical
 * request verifies and reuses it, while deleting could race another importer.
 */
export async function ingestPreparedBankImage(
    prepared: PreparedPrivateBankImage,
    bytes: Buffer,
    repository: BankImageRepository,
    storage: PrivateImageStorage,
): Promise<IngestResult> {
    const existing = await repository.find(prepared.row.source, prepared.row.sourceExternalId);
    if (existing) {
        if (!hasSameImmutableMetadata(existing, prepared.row)) return { status: "rejected", reason: "existing image metadata conflicts with this front" };
        if (existing.driveFileId && !existing.driveFileId.startsWith("secure:")) return { status: "rejected", reason: "existing image has a legacy source link" };
        if (existing.driveFileId) return existing.driveFileId === prepared.secureRef && await storedHashMatches(prepared, storage)
            ? { status: "existing" }
            : { status: "rejected", reason: "existing front has a different audited hash" };
    }

    const uploaded = await storage.upload(prepared.storagePath, bytes, prepared.storageMetadata);
    if (uploaded.error) {
        const prior = await storage.download(prepared.storagePath);
        if (!prior || createHash("sha256").update(prior).digest("hex") !== prepared.sha256) {
            return { status: "rejected", reason: "private storage rejected the front" };
        }
    }

    try {
        if (existing) {
            if (await repository.backfill(existing.id, prepared.secureRef)) return { status: "backfilled" };
            const winner = await repository.find(prepared.row.source, prepared.row.sourceExternalId);
            if (winner && hasSameImmutableMetadata(winner, prepared.row) && winner.driveFileId === prepared.secureRef && await storedHashMatches(prepared, storage)) return { status: "existing" };
            return { status: "rejected", reason: "concurrent image metadata conflicts with this front" };
        }
        await repository.create(prepared.row, prepared.secureRef);
        return { status: "created" };
    } catch (error) {
        if (!isP2002(error)) return { status: "rejected", reason: "metadata write failed; verified private object retained for retry" };
        const concurrent = await repository.find(prepared.row.source, prepared.row.sourceExternalId);
        if (concurrent && hasSameImmutableMetadata(concurrent, prepared.row) && concurrent.driveFileId === prepared.secureRef && await storedHashMatches(prepared, storage)) return { status: "existing" };
        return { status: "rejected", reason: "concurrent image metadata conflicts with this front" };
    }
}
