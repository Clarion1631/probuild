/**
 * The reference an Expense stores for a receipt this pipeline booked.
 *
 * `Expense.receiptUrl` used to be handed a raw signed URL by some writers and a
 * bare storage path by others. Both are wrong for a row that outlives them: a
 * signed URL expires (ten minutes later the link in the books is dead), and a
 * bare path says nothing about WHICH bucket it is in, which is exactly the
 * ambiguity that made receipts and contracts share one.
 *
 * So the column holds a STABLE, resolvable reference — `receipt-intake://<bucket>/<path>`
 * — and every reader mints a short-lived signed URL from it at read time.
 * Nothing in the database expires, and nothing dereferences a caller-supplied
 * URL.
 */
import { prisma } from "@/lib/prisma";
import { RECEIPT_BUCKET, signReceiptDownloadUrl } from "./bucket";
import type { RouteDeadline } from "@/lib/quickbooks";

export const RECEIPT_URL_SCHEME = "receipt-intake://";

/** Ten minutes: long enough to open, short enough that a leaked link is inert. */
export const RECEIPT_URL_TTL_SECONDS = 600;

export function receiptUrlRef(storagePath: string, bucket: string = RECEIPT_BUCKET): string {
    return `${RECEIPT_URL_SCHEME}${bucket}/${storagePath}`;
}

export function isReceiptUrlRef(value: string | null | undefined): boolean {
    return typeof value === "string" && value.startsWith(RECEIPT_URL_SCHEME);
}

export function parseReceiptUrl(value: string | null | undefined): { bucket: string; path: string } | null {
    if (!isReceiptUrlRef(value)) return null;
    const rest = (value as string).slice(RECEIPT_URL_SCHEME.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    const bucket = rest.slice(0, slash);
    const path = rest.slice(slash + 1);
    // Only OUR bucket, and never a traversal: this string ends up in a storage
    // API call, and it is read out of a database column that other code writes.
    if (bucket !== RECEIPT_BUCKET) return null;
    if (!path || path.startsWith("/") || path.includes("..")) return null;
    return { bucket, path };
}

export interface ReceiptUrlDeps {
    sign: (storagePath: string, ttlSeconds: number, deadline?: RouteDeadline) => Promise<string | null>;
    /** Where the intake row that owns this object points NOW. */
    currentPath: (storagePath: string) => Promise<string | null>;
}

const defaultDeps: ReceiptUrlDeps = {
    sign: signReceiptDownloadUrl,
    currentPath: async storagePath => {
        // Found through the Expense that carries this exact reference: the
        // intake row is the thing that tracks where the bytes ARE, and the ref
        // records where they were when the Purchase was written.
        const row = await prisma.receiptIntake.findFirst({
            where: { expense: { receiptUrl: receiptUrlRef(storagePath) } },
            select: { storagePath: true },
        });
        return row?.storagePath ?? null;
    },
};

/**
 * Mint a short-lived signed URL for a stored reference, or null.
 *
 * THE OBJECT MOVES. A row is published at the upload path, sealed to a
 * content-addressed one, and later archived — and the Expense was written
 * before some of that happened. So a reference that no longer resolves is
 * re-asked of the intake row, which is the thing that actually tracks where the
 * bytes are, before giving up.
 *
 * Never throws: a receipt that cannot be linked must render as "no receipt",
 * not take the expenses tab down.
 */
export async function resolveReceiptUrl(
    value: string | null | undefined,
    ttlSeconds: number = RECEIPT_URL_TTL_SECONDS,
    deps: ReceiptUrlDeps = defaultDeps,
): Promise<string | null> {
    const parsed = parseReceiptUrl(value);
    if (!parsed) return null;
    const direct = await deps.sign(parsed.path, ttlSeconds).catch(() => null);
    if (direct) return direct;
    // Moved (sealed or archived) since the Expense was written.
    const moved = await deps.currentPath(parsed.path).catch(() => null);
    if (!moved || moved === parsed.path) return null;
    return await deps.sign(moved, ttlSeconds).catch(() => null);
}

/**
 * Resolve `receipt-intake://` references on a batch of rows to short-lived
 * signed URLs, in parallel. A non-reference value (a legacy absolute URL, a
 * data URL, or null) passes through unchanged — same rule as resolveReceiptUrl,
 * just applied across a list instead of one row at a time.
 *
 * Every reader that renders `receiptUrl` as an href — the bookkeeper queue,
 * the project expenses tab — must resolve it first: the column stores the
 * stable reference book.ts writes, not a link a browser can open.
 */
export async function resolveReceiptUrls<T extends { receiptUrl: string | null }>(
    rows: T[],
    ttlSeconds: number = RECEIPT_URL_TTL_SECONDS,
    deps: ReceiptUrlDeps = defaultDeps,
): Promise<T[]> {
    return Promise.all(rows.map(async row => ({
        ...row,
        receiptUrl: isReceiptUrlRef(row.receiptUrl)
            ? await resolveReceiptUrl(row.receiptUrl, ttlSeconds, deps)
            : row.receiptUrl,
    })));
}
