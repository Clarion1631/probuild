/**
 * Push a finalized receipt/check Purchase directly into QuickBooks Online.
 * Replaces the Apps Script's email-to-QBO leg — see
 * docs/apps-script/sendToQBOviaAPI.gs — with ProBuild creating the Purchase
 * directly, job-coded at the line level, with the receipt file attached, so
 * the bank feed shows a ready match.
 *
 * QBO is the source of record and this writes to REAL BOOKS, so every
 * validation here is deliberately conservative and terminal (never a silent
 * fallback) rather than best-effort:
 *  - DocNumber = the Drive fileId (truncated to 21 chars) is the client-side
 *    idempotency key, backed by a QBO-side `requestid` on the create call for
 *    server-side idempotency against a lost-response retry.
 *  - The project match is EXACT (normalized) — never a fuzzy guess.
 *  - The QBO customer is resolved PER PROJECT (by project name), never via
 *    Client.qbCustomerId — a Client can own several concurrent projects, each
 *    billed to its own QBO customer named after the job.
 *
 * ensureQBVendor mirrors ensureQBCustomer in ./quickbooks.ts exactly, against
 * the Vendor entity. createQBReceiptPurchase's dependency-injection shape
 * mirrors syncQboExpenses in ./qbo-expense-sync.ts.
 */
import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import {
    qbFetch,
    qbQuery,
    escapeQBString,
    ensureQBCustomer,
    QB_API_BASE,
    qbTimedFetch,
    parseJsonOrNull,
    isQBTimeoutError,
    isQBTokenStrandedError,
    isBudgetExhausted,
    remainingBudgetMs,
    createRouteDeadline,
    QBBudgetExhaustedError,
    qboHttpStatus,
    isTransientQboStatus,
    qboResponseError,
    type RouteDeadline,
    QboRetryableError,
    isRetryableQboError,
    isRetryableQboStatus,
    type QBTokens,
    type QBAttachable,
} from "./quickbooks";

// Retryable-failure vocabulary lives in quickbooks.ts (the payments rail needs
// it too); re-exported here because this module's callers already import it.
export { QboRetryableError, isRetryableQboError, isRetryableQboStatus };

/**
 * Statuses where retrying the ATTACHMENT upload is worthwhile.
 *
 * Wider than isRetryableQboStatus on purpose: 408 (request timeout) and 401
 * (expired access token, repaired by a refresh) used to be banked as a terminal
 * `failed:<status>` on an ok:true response, which stops the Apps Script
 * resending and leaves a freshly created Purchase without its receipt forever.
 * A 4xx that means "QBO will never accept this file" (400/403/404/413/415)
 * stays terminal - retrying that is a loop, not a repair.
 */
export function isTransientAttachmentStatus(status: number): boolean {
    return status === 401 || status === 408 || isRetryableQboStatus(status);
}

/**
 * The attachment upload or lookup was refused on the CREDENTIAL, not the file
 * — a 401 that survived a forced token refresh, or a 403. Distinct from a QBO
 * business-rule fault: reconnecting QuickBooks fixes this, retrying with the
 * same token never will, and it must not be reported as a terminal
 * `failed:<status>` next to `ok:true` either, or the Apps Script stops
 * resending and the receipt keeps its missing image until someone notices the
 * connection is down.
 */
export class QboAttachmentAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.name = "QboAttachmentAuthError";
        this.status = status;
    }
}

/** Name-based, for the same cross-module-identity reason as isQBTimeoutError. */
export function isQboAttachmentAuthError(error: unknown): error is QboAttachmentAuthError {
    return (
        error instanceof QboAttachmentAuthError ||
        (error instanceof Error && error.name === "QboAttachmentAuthError")
    );
}

/** Thrown by ensureQBVendor when QBO rejects the create as a duplicate name (fault 6240) and a re-query still can't find it. */
export class QboVendorDuplicateError extends Error {
    constructor(name: string) {
        super(`QB vendor "${name}" could not be created (duplicate name, fault 6240) and no match was found on re-query.`);
        this.name = "QboVendorDuplicateError";
    }
}

/** Thrown by the Purchase create call when QBO returns a business-rule fault (400/403) — never for transient/network failures. */
export class QboPurchaseFaultError extends Error {
    status: number;
    faultCode?: string;
    constructor(status: number, message: string, faultCode?: string) {
        super(message);
        this.name = "QboPurchaseFaultError";
        this.status = status;
        this.faultCode = faultCode;
    }
}

/** Find a QBO vendor by display name, creating it if missing. Returns the QBO vendor Id. */
export async function ensureQBVendor(
    tokens: QBTokens,
    name: string,
    deadline?: RouteDeadline,
): Promise<string> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Vendor name is empty — cannot sync vendor to QuickBooks.");

    const byName = await qbQuery(tokens, `SELECT Id FROM Vendor WHERE DisplayName = '${escapeQBString(trimmed)}'`, deadline);
    if (byName.length > 0) return byName[0].Id;

    // QBO normalizes whitespace when enforcing DisplayName uniqueness, so an
    // exact match can miss while create still rejects as a duplicate (fault 6240).
    // Prefix on the first word only, so internal-whitespace variants still match.
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const prefix = trimmed.split(/\s+/)[0];
    const candidates = await qbQuery<{ Id: string; DisplayName?: string }>(
        tokens,
        `SELECT Id, DisplayName FROM Vendor WHERE DisplayName LIKE '${escapeQBString(prefix)}%' MAXRESULTS 1000`,
        deadline,
    );
    const matches = candidates.filter(c => normalize(c.DisplayName ?? "") === normalize(trimmed));
    if (matches.length > 1) {
        throw new Error(`QB vendor lookup for "${trimmed}" matched ${matches.length} vendors — resolve the duplicate in QuickBooks.`);
    }
    if (matches.length === 1) return matches[0].Id;

    const res = await qbFetch("/vendor", tokens, {
        qbDeadline: deadline,
        method: "POST",
        body: JSON.stringify({ DisplayName: trimmed }),
    });
    if (!res.ok) {
        // 408/429/5xx is QuickBooks being unavailable, not a verdict on this
        // vendor — classify it before any body sniffing.
        if (isTransientQboStatus(res.status)) throw await qboResponseError(res, "QB vendor create");
        const err = await res.text();
        if (err.includes("6240")) {
            // A concurrent create can win the race between our lookup and our
            // create — re-query once rather than assuming the duplicate is gone.
            const requery = await qbQuery(tokens, `SELECT Id FROM Vendor WHERE DisplayName = '${escapeQBString(trimmed)}'`, deadline);
            if (requery.length > 0) return requery[0].Id;
            throw new QboVendorDuplicateError(trimmed);
        }
        // Other business-rule rejections (invalid name, closed books, scope)
        // are deterministic — surface as a fault so the route maps them to a
        // terminal ok:false instead of a forever-retried 500.
        if (res.status === 400 || res.status === 403) {
            const faultCode = err.match(/"code"\s*:\s*"(\d+)"/)?.[1];
            throw new QboPurchaseFaultError(res.status, `QB vendor create failed: ${err}`, faultCode);
        }
        throw new Error(`QB vendor create failed: ${err}`);
    }
    const data = await parseJsonOrNull(res);
    if (!data?.Vendor?.Id) {
        const faultCode = data?.Fault?.Error?.[0]?.code;
        if (data?.Fault) {
            throw new QboPurchaseFaultError(res.status, `QB vendor create returned a Fault: ${JSON.stringify(data.Fault).slice(0, 500)}`, faultCode);
        }
        throw new Error("QB vendor create returned no Vendor body");
    }
    return data.Vendor.Id;
}

export interface QboReceiptLine {
    sku?: string;
    desc?: string;
    price?: string | number;
}

export interface QboReceiptGroup {
    category: string;
    amount: number;
    lines?: QboReceiptLine[];
    /**
     * Sales-tax line: posts to the reimbursable-sales-tax account instead of
     * the default expense account. GTR holds a reseller's permit, so tax paid
     * to vendors without the certificate on file is recoverable via a state
     * filing — it must be visible as its own account, not buried in COGS.
     */
    tax?: boolean;
}

export interface CreateQBReceiptPurchaseInput {
    projectName: string;
    docType?: string;
    vendor?: string;
    date?: string; // YYYY-MM-DD, required and must be calendar-valid — no fallback
    invoice?: string;
    checkNumber?: string;
    memo?: string;
    totalAmount: number;
    fileId: string; // Drive file id — dedupe key (DocNumber = fileId.slice(0, 21))
    fileName?: string;
    groups: QboReceiptGroup[];
    fileBase64?: string;
    fileContentType?: string;
    /**
     * Shop/overhead docs: the QBO expense-account NAME to post the lines to
     * (the Drive category folder mirrors the chart of accounts, e.g. "Vehicle
     * expenses", "Meals"). When set, the lines post to that account instead of
     * the default COGS expense account — resolved by EXACT name against
     * Expense / Other Expense accounts, terminal ok:false when it can't be.
     * Tax-split groups are refused with overheadCategory: the reseller-permit
     * reclaim only applies to job materials, never overhead purchases.
     */
    overheadCategory?: string;
}

/**
 * "attached" | "already-attached" | "skipped" | "failed:<short reason>" — a
 * failure never fails the Purchase create.
 */
export type ReceiptAttachmentStatus = "attached" | "already-attached" | "skipped" | `failed:${string}`;

export type CreateQBReceiptPurchaseResult =
    | { ok: true; qbPurchaseId: string; docNumber: string; alreadyExists: true; attachment: ReceiptAttachmentStatus }
    | { ok: true; qbPurchaseId: string; docNumber: string; alreadyExists: false; attachment: ReceiptAttachmentStatus }
    | { ok: false; reason: "project-not-matched"; projectName: string }
    | { ok: false; reason: "docnumber-conflict"; docNumber: string }
    | { ok: false; reason: "invalid-group-amount" }
    | { ok: false; reason: "amount-mismatch"; groupsSum: number; totalAmount: number }
    | { ok: false; reason: "missing-vendor" }
    | { ok: false; reason: "invalid-date" }
    | { ok: false; reason: "duplicate-name" }
    | { ok: false; reason: "overhead-account-not-matched"; category: string }
    | { ok: false; reason: "overhead-tax-unsupported" };

export interface QboReceiptProjectCandidate {
    id: string;
    name: string;
}

export interface QboReceiptPushDependencies {
    qbQueryFn: <T = any>(tokens: QBTokens, query: string) => Promise<T[]>;
    qbCreateFn: (tokens: QBTokens, payload: Record<string, unknown>, requestId: string) => Promise<{ id: string }>;
    ensureVendorFn: (tokens: QBTokens, name: string) => Promise<string>;
    // Injectable (unlike the plain re-export of ensureQBCustomer) because the
    // customer is now resolved on EVERY create — there is no more per-client
    // cached id to short-circuit it, so tests need a seam here too.
    ensureCustomerFn: (tokens: QBTokens, client: { name: string }) => Promise<string>;
    listProjects: () => Promise<QboReceiptProjectCandidate[]>;
    uploadAttachment: (
        tokens: QBTokens,
        purchaseId: string,
        file: { base64: string; contentType: string; fileName: string },
    ) => Promise<ReceiptAttachmentStatus>;
    /**
     * Forced token refresh used by the 401 retry on the attachment lookup and
     * upload. Injectable for the same reason the other QBO calls are: those
     * retries are real behaviour that needs covering without a live Intuit.
     */
    refreshTokensFn: () => Promise<QBTokens>;
}

const BANK_ACCOUNT_ID_DEFAULT = "154"; // Washington Trust Bank
const EXPENSE_ACCOUNT_ID_DEFAULT = "98"; // COGS Supplies & materials
const TAX_ACCOUNT_ID_DEFAULT = "1150040032"; // COGS "Reimbursable Sales Tax Paid"
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function receiptRequestId(fileId: string): string {
    // QBO's create-request idempotency key (distinct from DocNumber): a stable
    // hash of the FULL fileId, capped at QBO's 50-char requestid limit.
    return createHash("sha256").update(fileId).digest("hex").slice(0, 50);
}

function normalizeProjectName(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** EXACT normalized name match only — never a fuzzy guess against real books. */
function findExactProjectMatch(
    projectName: string,
    projects: QboReceiptProjectCandidate[],
): QboReceiptProjectCandidate | null {
    const target = normalizeProjectName(projectName);
    const matches = projects.filter(p => normalizeProjectName(p.name) === target);
    return matches.length === 1 ? matches[0] : null;
}

/** Same round-trip validation parseBackfillDate uses in the qbo-expenses/sync route. */
function isValidCalendarDate(value: unknown): value is string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Strict allowlist on the MIME essence — the value is inserted into a
 * multipart header line, so anything beyond a bare known token is rejected
 * (no parameters, no CR/LF smuggling like "image/jpeg\r\nX-Test: x").
 */
const ATTACHABLE_CONTENT_TYPES = new Set([
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "image/heic", "image/heif", "application/pdf",
]);

function normalizeAttachableContentType(contentType: string): string | null {
    const essence = contentType.split(";")[0].trim().toLowerCase();
    return ATTACHABLE_CONTENT_TYPES.has(essence) ? essence : null;
}

/** Decode-reencode compare — catches truncated/corrupted base64 before it's sent anywhere. */
function isValidBase64(value: string): boolean {
    if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
    try {
        return Buffer.from(value, "base64").toString("base64") === value;
    } catch {
        return false;
    }
}

async function defaultQbCreatePurchase(
    tokens: QBTokens,
    payload: Record<string, unknown>,
    requestId: string,
    deadline?: RouteDeadline,
): Promise<{ id: string }> {
    const res = await qbFetch(`/purchase?requestid=${encodeURIComponent(requestId)}`, tokens, {
        method: "POST",
        body: JSON.stringify(payload),
        qbDeadline: deadline,
    });
    if (!res.ok) {
        // Transient first: a 503 here is an outage, not a business rule.
        if (isTransientQboStatus(res.status)) throw await qboResponseError(res, "QB purchase create");
        const text = await res.text();
        // A business-rule rejection (bad account ref, closed period, ...) is
        // terminal and distinct from a transient/network failure — thread the
        // QBO status + fault code up so the route can map it to a stable,
        // non-retryable outcome instead of a generic 500.
        if (res.status === 400 || res.status === 403) {
            const faultCode = text.match(/"code"\s*:\s*"(\d+)"/)?.[1];
            throw new QboPurchaseFaultError(res.status, `QB purchase create failed: ${text}`, faultCode);
        }
        throw new Error(`QB purchase create failed: ${text}`);
    }
    const data = await parseJsonOrNull(res);
    // Intuit documents that a 200 response can still carry a Fault body.
    if (!data?.Purchase?.Id) {
        const faultCode = data?.Fault?.Error?.[0]?.code;
        if (data?.Fault) {
            throw new QboPurchaseFaultError(res.status, `QB purchase create returned a Fault: ${JSON.stringify(data.Fault).slice(0, 500)}`, faultCode);
        }
        throw new Error("QB purchase create returned no Purchase body");
    }
    return { id: data.Purchase.Id };
}

async function defaultListInProgressProjects(): Promise<QboReceiptProjectCandidate[]> {
    return prisma.project.findMany({
        where: { status: "In Progress" },
        select: { id: true, name: true },
    });
}

/**
 * Upload a receipt file as a QBO Attachable linked to a Purchase via the
 * multipart Attachable endpoint. Best-effort: the Purchase itself is already
 * created by the time this runs — callers must still treat a thrown error as
 * a non-fatal "failed:<reason>".
 */
/**
 * The Attachable FileName we upload under. Deterministic for a given receipt,
 * which is what lets a later run recognise its own upload instead of adding a
 * duplicate. Strips CR/LF/quotes so the name can't break out of the multipart
 * header line.
 */
export function attachmentFileName(rawFileName: string | undefined): string {
    return (rawFileName || "receipt").replace(/[\r\n"]/g, "") || "receipt";
}

export async function defaultUploadAttachment(
    tokens: QBTokens,
    purchaseId: string,
    file: { base64: string; contentType: string; fileName: string },
    /** Injectable for tests; defaults to the real token refresh. */
    refreshTokens?: () => Promise<QBTokens>,
    deadline?: RouteDeadline,
): Promise<ReceiptAttachmentStatus> {
    const safeFileName = attachmentFileName(file.fileName);
    const fileBytes = Buffer.from(file.base64, "base64");
    const metadata = {
        AttachableRef: [{ EntityRef: { value: purchaseId, type: "Purchase" } }],
        FileName: safeFileName,
        ContentType: file.contentType,
    };
    const boundary = `gtrReceipt${Date.now()}${Math.random().toString(16).slice(2)}`;
    const CRLF = "\r\n";
    const body = Buffer.concat([
        Buffer.from(
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="file_metadata_01"${CRLF}` +
            `Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}` +
            `${JSON.stringify(metadata)}${CRLF}`,
        ),
        Buffer.from(
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="file_content_01"; filename="${safeFileName}"${CRLF}` +
            `Content-Type: ${file.contentType}${CRLF}${CRLF}`,
        ),
        fileBytes,
        Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
    ]);

    // The forced refresh on a 401 is itself a QBO round trip, so it runs under
    // the same budget as everything else.
    const refresh = refreshTokens ?? (async () => {
        const { getFreshQBTokens } = await import("./quickbooks-payments");
        return getFreshQBTokens(deadline);
    });

    const post = (active: QBTokens) =>
        qbTimedFetch(`${QB_API_BASE}/${active.realmId}/upload?minorversion=73`, {
            qbDeadline: deadline,
            method: "POST",
            headers: {
                Authorization: `Bearer ${active.accessToken}`,
                Accept: "application/json",
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
            },
            body,
        });

    let res = await post(tokens);
    // A 401 here usually just means the access token aged out mid-push. One
    // forced refresh repairs it in place; without this the receipt waited for a
    // whole extra bot pass (or, before transient statuses were retryable at
    // all, was abandoned entirely).
    if (res.status === 401) {
        // `.catch(() => null)` swallowed the reason the refresh failed, so a
        // QBO outage, a stranded token, or a persistence failure all became an
        // indistinguishable "no fresh token" and the push carried on to report
        // a plain 401. Those are all things a human or a retry must know about.
        const refreshed = await refresh().catch((error: unknown) => {
            if (
                isQBTimeoutError(error) ||
                isRetryableQboError(error) ||
                isQBTokenStrandedError(error) ||
                (error instanceof Error && error.name === "QBTokenPersistenceError")
            ) {
                throw error;
            }
            return null;
        });
        if (refreshed) res = await post(refreshed);
    }
    if (!res.ok) {
        // A 401 that reaches here already survived the forced refresh above —
        // it, and a 403, mean QBO is refusing the CREDENTIAL, not the file.
        // Neither is a transient outage (QboRetryableError) nor a business
        // fault a retry will repeat identically forever (failed:<status>) —
        // it is a distinct, reconnect-and-it-fixes-itself failure.
        if (res.status === 401 || res.status === 403) {
            throw new QboAttachmentAuthError(res.status, `QB attachment upload rejected the credential (status ${res.status})`);
        }
        // Busy, timed out: QBO is not refusing this file, so raise and let the
        // push be retried rather than banking a terminal "failed:503" next to
        // ok:true.
        if (isTransientAttachmentStatus(res.status)) {
            throw new QboRetryableError(`QB attachment upload failed with status ${res.status}`, res.status);
        }
        return `failed:${res.status}`;
    }
    const data = await parseJsonOrNull(res);
    const fault = data?.AttachableResponse?.[0]?.Fault;
    // A Fault is a business rejection (bad ref, unsupported type) — terminal.
    if (fault) return "failed:fault";
    // Intuit's schema says an AttachableResponse carries either an Attachable
    // or a Fault — absence is NOT success. An empty, truncated, or HTML 200
    // (proxy/CDN error pages are the usual source) used to fall through to
    // "attached", banking a terminal success for a file that was never stored,
    // so the bot never came back for it. Demand the created id.
    if (!data?.AttachableResponse?.[0]?.Attachable?.Id) {
        throw new QboRetryableError("QB attachment upload returned no Attachable id");
    }
    return "attached";
}

/**
 * The upload arguments for a receipt, or null when there is nothing uploadable
 * (no file, unsupported content type, corrupt base64, oversized). Shared by the
 * fresh-create and already-exists paths so both compute the SAME deterministic
 * FileName — that is what makes the existence check below meaningful.
 */
function planAttachmentUpload(
    input: CreateQBReceiptPurchaseInput,
): { base64: string; contentType: string; fileName: string } | null {
    if (!input.fileBase64) return null;
    const contentType = normalizeAttachableContentType(input.fileContentType || "");
    if (!contentType) return null;
    if (!isValidBase64(input.fileBase64)) return null;
    if (Buffer.byteLength(input.fileBase64, "base64") > MAX_ATTACHMENT_BYTES) return null;
    return { base64: input.fileBase64, contentType, fileName: attachmentFileName(input.fileName) };
}

/**
 * Attach the receipt to a Purchase that already exists.
 *
 * Reached when the DocNumber lookup finds our own earlier Purchase — most
 * often because the FIRST attempt's response was lost after QBO had already
 * committed it (a timeout, or the function being killed). That attempt never
 * got to upload the file, and the old early return meant no later attempt ever
 * would either: the receipt stayed in QBO with no image, forever.
 *
 * Idempotent by deterministic FileName: if an Attachable for this Purchase
 * already carries the name we would upload under, this is a no-op. Never
 * throws — the books entry exists and must not be undone by an image problem.
 */
async function ensureAttachmentOnExistingPurchase(
    tokens: QBTokens,
    purchaseId: string,
    input: CreateQBReceiptPurchaseInput,
    qbQueryFn: QboReceiptPushDependencies["qbQueryFn"],
    uploadAttachment: QboReceiptPushDependencies["uploadAttachment"],
    deadline?: RouteDeadline,
    /** Injectable for tests; defaults to the real token refresh. */
    refreshTokens?: () => Promise<QBTokens>,
): Promise<ReceiptAttachmentStatus> {
    const plan = planAttachmentUpload(input);
    if (!plan) return "skipped";
    // QBO transaction ids are numeric; refuse anything else rather than escape it.
    if (!/^\d+$/.test(purchaseId)) return "skipped";

    const refresh = refreshTokens ?? (async () => {
        const { getFreshQBTokens } = await import("./quickbooks-payments");
        return getFreshQBTokens(deadline);
    });
    const lookupSql = `SELECT * FROM attachable WHERE AttachableRef.EntityRef.value = '${purchaseId}'`;

    try {
        // The token can age out between the Purchase lookup and here, exactly
        // as it can on the upload. One forced refresh repairs it in place
        // instead of costing the receipt a whole extra bot pass.
        let activeTokens = tokens;
        let rows: QBAttachable[];
        try {
            rows = await qbQueryFn<QBAttachable>(activeTokens, lookupSql);
        } catch (error) {
            if (qboHttpStatus(error) !== 401) throw error;
            // Identical handling to the upload branch above: a typed refresh
            // failure is the thing a human needs to act on, and swallowing it
            // made a QBO outage, a stranded token and a persistence failure all
            // look like an ordinary 401 on the lookup.
            const refreshed = await refresh().catch((refreshError: unknown) => {
                if (
                    isQBTimeoutError(refreshError) ||
                    isRetryableQboError(refreshError) ||
                    isQBTokenStrandedError(refreshError) ||
                    (refreshError instanceof Error && refreshError.name === "QBTokenPersistenceError")
                ) {
                    throw refreshError;
                }
                return null;
            });
            if (!refreshed) throw error;
            activeTokens = refreshed;
            rows = await qbQueryFn<QBAttachable>(activeTokens, lookupSql);
        }
        // Entity ids are only unique per entity type, so a value-only query can
        // surface attachments from other transaction types — keep Purchase links.
        const alreadyAttached = (rows ?? []).some(
            row =>
                row?.AttachableRef?.some(
                    ref =>
                        ref.EntityRef?.value === purchaseId &&
                        /^purchase$/i.test(ref.EntityRef?.type ?? ""),
                ) && (row.FileName ?? "") === plan.fileName,
        );
        if (alreadyAttached) return "already-attached";
        return await uploadAttachment(activeTokens, purchaseId, plan);
    } catch (error) {
        // Retryable: our deadline, a 429/5xx, a transport failure. These say
        // nothing about the file, so they must NOT become a terminal `failed:`
        // on an ok:true response — that is what made the Apps Script stop
        // resending and leave the Purchase unattached.
        //
        // Token failures pass through UNCHANGED rather than being re-wrapped:
        // a stranded or unpersisted token is a connection that needs human
        // attention, and flattening it into a generic retryable error loses
        // exactly the detail that says so.
        if (
            isQBTimeoutError(error) ||
            isRetryableQboError(error) ||
            isQBTokenStrandedError(error) ||
            isQboAttachmentAuthError(error) ||
            (error instanceof Error && error.name === "QBTokenPersistenceError")
        ) {
            throw error;
        }

        // A 401 that reaches here already survived the forced refresh above —
        // it, and a 403, are the credential being refused, not the file or the
        // lookup query. Same reasoning as the upload path: neither a transient
        // outage nor a repeating business fault.
        const status = qboHttpStatus(error);
        if (status === 401 || status === 403) {
            throw new QboAttachmentAuthError(status, `QB attachment lookup rejected the credential (status ${status})`);
        }
        // Same transient set as the upload path, which this must match: 408
        // joins 429/5xx as retryable.
        if (status !== null && isTransientAttachmentStatus(status)) {
            throw new QboRetryableError(`QB attachment lookup failed with status ${status}`, status);
        }
        // Terminal: QuickBooks answered with a refusal that will repeat. A
        // 400/403/404 is a real answer (bad query, no access, no such
        // purchase) — retrying it forever is a loop, so it rides along on
        // ok:true as a recorded failure instead.
        if (status !== null) {
            return `failed:${status}`;
        }

        // Unclassifiable — treat as retryable rather than silently bank it.
        throw new QboRetryableError(
            `QB attachment step failed: ${error instanceof Error ? error.name : "error"}`,
        );
    }
}

/**
 * Verify the configured bank/expense accounts are what they claim to be, once
 * per process, before the first Purchase create. A mismatch means the env is
 * misconfigured (wrong account id after a QBO chart-of-accounts change, wrong
 * realm, ...) — this must throw and never let a Purchase post against the
 * wrong account.
 */
/**
 * Deterministic account misconfiguration (wrong id/type/name, or two roles
 * pointing at the same account). The route maps this to 200 ok:false so the
 * bot falls back to the email path — a generic throw would 500 and put EVERY
 * document into an infinite retry loop against a config that can't succeed.
 */
export class QboAccountConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "QboAccountConfigError";
    }
}

// Keyed by realm + account ids so a reconnect to a different QBO company (or
// an env change) re-verifies, and rejected entries are evicted so one
// transient query failure can't poison a warm process forever.
/**
 * Completed verifications only, with a TTL.
 *
 * Caching the in-flight PROMISE bound every waiter to the first request's
 * lifetime: a second request with two seconds of budget left would await a
 * verification started under someone else's 50s deadline, and sit there long
 * past its own. Worse, a request that had already given up left its promise in
 * the map for the next one to inherit. Now only a finished, successful result
 * is cached; concurrent callers still share the in-flight work (below) but
 * each RACES it against its own budget and walks away on time.
 */
const verifiedAccountsCache = new Map<string, number>();
/** Short TTL: account config is mutable, and this only exists to skip repeat round trips. */
const VERIFIED_ACCOUNTS_TTL_MS = 5 * 60_000;
/**
 * The shared verification's OWN budget, independent of whoever happened to
 * start it.
 *
 * Binding it to the initiator's deadline meant a push with 700ms left would
 * kick off the verification everyone else waits on and then poison it for all
 * of them. The shared work gets a fixed, generous budget; each waiter races it
 * against its own remaining time (below) and walks away alone.
 */
const ACCOUNT_VERIFY_BUDGET_MS = 20_000;
/** In-flight verifications, shared so concurrent pushes do not duplicate the queries. */
const verifyingAccounts = new Map<string, Promise<void>>();

/**
 * Resolve a Shop/overhead category folder name to its QBO expense account by
 * EXACT name match — never fuzzy, this picks where real money posts. Accepts
 * Expense and Other Expense types (GTR's "Vehicle expenses" bucket is Other
 * Expense). Returns null when no single active match exists — the caller maps
 * that to a terminal ok:false so the bot books via the email path instead.
 *
 * DELIBERATELY UNCACHED. Accounts are mutable: renaming "Meals" in QBO must
 * stop matching the name immediately, and any cache — even a short-TTL one —
 * leaves a window where a receipt posts to an account that no longer carries
 * the category's name. One extra query per overhead receipt (a handful a day)
 * buys a guarantee that the id was verified against the CURRENT name.
 */
async function resolveOverheadAccountId(
    tokens: QBTokens,
    qbQueryFn: QboReceiptPushDependencies["qbQueryFn"],
    category: string,
): Promise<string | null> {
    const rows = await qbQueryFn<{ Id: string; Name?: string; AccountType?: string; Active?: boolean }>(
        tokens,
        `SELECT Id, Name, AccountType, Active FROM Account WHERE Name = '${escapeQBString(category)}'`,
    );
    const matches = rows.filter(
        r => r.Active !== false && (r.AccountType === "Expense" || r.AccountType === "Other Expense"),
    );
    return matches.length === 1 ? matches[0].Id : null;
}

async function verifyReceiptAccounts(
    tokens: QBTokens,
    /**
     * Deliberately NOT the caller's query function: this runs on the shared
     * verification's own clock so one impatient request cannot cut short the
     * work every concurrent push is waiting on.
     */
    qbQueryFn: QboReceiptPushDependencies["qbQueryFn"],
    bankAccountId: string,
    expenseAccountId: string,
    taxAccountId: string,
    deadline?: RouteDeadline,
): Promise<void> {
    const cacheKey = `${tokens.realmId}|${bankAccountId}|${expenseAccountId}|${taxAccountId}`;

    const verifiedAt = verifiedAccountsCache.get(cacheKey);
    if (verifiedAt !== undefined && Date.now() - verifiedAt < VERIFIED_ACCOUNTS_TTL_MS) return;

    let verifyingPromise = verifyingAccounts.get(cacheKey);
    if (!verifyingPromise) {
        verifyingPromise = (async () => {
            // Role separation: the whole point of the tax account is a clean
            // filing report, so it must not collapse onto another role's
            // account (e.g. QBO_RECEIPT_TAX_ACCOUNT_ID pasted as "98").
            if (taxAccountId === expenseAccountId || taxAccountId === bankAccountId) {
                throw new QboAccountConfigError(
                    `QBO receipt push is misconfigured: tax account ${taxAccountId} must be distinct ` +
                    `from the expense (${expenseAccountId}) and bank (${bankAccountId}) accounts.`,
                );
            }
            const [bankRows, expenseRows, taxRows] = await Promise.all([
                qbQueryFn<{ Id: string; Name?: string; AccountType?: string }>(
                    tokens,
                    `SELECT Id, Name, AccountType FROM Account WHERE Id = '${escapeQBString(bankAccountId)}'`,
                ),
                qbQueryFn<{ Id: string; Name?: string; AccountType?: string }>(
                    tokens,
                    `SELECT Id, Name, AccountType FROM Account WHERE Id = '${escapeQBString(expenseAccountId)}'`,
                ),
                qbQueryFn<{ Id: string; Name?: string; AccountType?: string }>(
                    tokens,
                    `SELECT Id, Name, AccountType FROM Account WHERE Id = '${escapeQBString(taxAccountId)}'`,
                ),
            ]);
            const bank = bankRows[0];
            const expense = expenseRows[0];
            const tax = taxRows[0];
            const bankOk = !!bank && bank.AccountType === "Bank" && /Washington Trust/i.test(bank.Name ?? "");
            const expenseOk = !!expense && expense.AccountType === "Cost of Goods Sold";
            // The default is COGS "Reimbursable Sales Tax Paid", but an
            // Expense-type override (e.g. "Sales Tax Paid", TaxesPaid) is also
            // legitimate for a tax bucket.
            const taxOk = !!tax && (tax.AccountType === "Cost of Goods Sold" || tax.AccountType === "Expense");
            if (!bankOk || !expenseOk || !taxOk) {
                throw new QboAccountConfigError(
                    `QBO receipt push is misconfigured: bank account ${bankAccountId} is ` +
                    `${bank?.AccountType ?? "missing"}/"${bank?.Name ?? "missing"}" (need Bank/"Washington Trust"); ` +
                    `expense account ${expenseAccountId} is ${expense?.AccountType ?? "missing"} (need Cost of Goods Sold); ` +
                    `tax account ${taxAccountId} is ${tax?.AccountType ?? "missing"} (need Cost of Goods Sold or Expense).`,
                );
            }
            // Only a COMPLETED, successful verification is remembered.
            verifiedAccountsCache.set(cacheKey, Date.now());
        })();
        verifyingAccounts.set(cacheKey, verifyingPromise);
        // Always clear the in-flight slot, success or failure, so a request
        // that gave up cannot leave a stale promise for the next one.
        verifyingPromise.catch(() => {}).finally(() => {
            if (verifyingAccounts.get(cacheKey) === verifyingPromise) verifyingAccounts.delete(cacheKey);
        });
    }

    // Share the work, but never inherit another request's clock: this waiter
    // gives up when ITS OWN budget runs out, leaving the shared verification to
    // finish (or not) for whoever else is waiting.
    const remaining = remainingBudgetMs(deadline);
    if (!Number.isFinite(remaining)) return verifyingPromise;
    if (remaining <= 0) {
        throw new QBBudgetExhaustedError("Route budget exhausted before the QBO account verification");
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const budgetExpiry = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new QBBudgetExhaustedError("Route budget exhausted while verifying QBO accounts")),
            Math.max(1, Math.floor(remaining)),
        );
    });
    try {
        await Promise.race([verifyingPromise, budgetExpiry]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Create (or reuse) the finalized QBO Purchase for one receipt/check document,
 * job-coded per category group at the line level.
 *
 * Order matters: idempotency, project match, required-field checks, and money
 * validation ALL run before any QBO entity (customer/vendor) is touched or the
 * account-identity check fires, so a bad payload never creates or looks up
 * anything in QuickBooks beyond the initial DocNumber query.
 */
export async function createQBReceiptPurchase(
    tokens: QBTokens,
    input: CreateQBReceiptPurchaseInput,
    deps: Partial<QboReceiptPushDependencies> = {},
    /**
     * Whole-route budget. A push makes several serial QBO calls (lookups,
     * vendor/customer ensures, account verify, create, upload); each is
     * individually bounded, but only a shared budget stops the SUM from
     * running past the route ceiling and being killed mid-write.
     */
    deadline?: RouteDeadline,
): Promise<CreateQBReceiptPurchaseResult> {
    const qbQueryFn = deps.qbQueryFn ?? ((t, q) => qbQuery(t, q, deadline));
    const qbCreateFn = deps.qbCreateFn ?? ((t, p, r) => defaultQbCreatePurchase(t, p, r, deadline));
    // Every default QBO call carries the route budget: the ensures are two more
    // serial round trips, and they were the gap that let a push still overrun.
    const ensureVendorFn = deps.ensureVendorFn ?? ((t, n) => ensureQBVendor(t, n, deadline));
    const ensureCustomerFn = deps.ensureCustomerFn ?? ((t, c) => ensureQBCustomer(t, c, deadline));
    const listProjects = deps.listProjects ?? defaultListInProgressProjects;
    const refreshTokensFn = deps.refreshTokensFn ?? (async () => {
        const { getFreshQBTokens } = await import("./quickbooks-payments");
        return getFreshQBTokens(deadline);
    });
    const uploadAttachment = deps.uploadAttachment ?? ((t, id, f) => defaultUploadAttachment(t, id, f, refreshTokensFn, deadline));
    // The QBO calls above (queries, ensures, create, upload) are all bounded by
    // `deadline`; the account-identity verify below goes through qbQueryFn, so
    // it is covered too.

    const docNumber = input.fileId.slice(0, 21);
    const marker = `[gtr-file:${input.fileId}]`;

    // Idempotency first — never re-create a Purchase for a file already
    // pushed. A DocNumber hit whose PrivateNote does NOT carry this file's
    // full marker is a genuine id collision (truncated to 21 chars — two
    // different Drive fileIds can share that prefix), not a re-send: refuse
    // rather than silently attach to the wrong Purchase.
    const existing = await qbQueryFn<{ Id: string; PrivateNote?: string }>(
        tokens,
        `SELECT Id, PrivateNote FROM Purchase WHERE DocNumber = '${escapeQBString(docNumber)}'`,
    );
    if (existing.length > 0) {
        if (existing.length > 1 || !(existing[0].PrivateNote ?? "").includes(marker)) {
            return { ok: false, reason: "docnumber-conflict", docNumber };
        }
        // The Purchase exists, but that does NOT mean the receipt file made it
        // across. The common way to reach this branch is a first attempt whose
        // Purchase response was lost (timeout/kill) AFTER QBO committed it —
        // and the old code returned here without ever reaching the upload
        // below, so that receipt was stranded with no image, permanently:
        // every retry took this same early return. Re-check and fill the gap.
        const attachment = await ensureAttachmentOnExistingPurchase(
            tokens,
            existing[0].Id,
            input,
            qbQueryFn,
            uploadAttachment,
            deadline,
            refreshTokensFn,
        );
        return { ok: true, qbPurchaseId: existing[0].Id, docNumber, alreadyExists: true, attachment };
    }

    const projects = await listProjects();
    const project = findExactProjectMatch(input.projectName, projects);
    if (!project) {
        return { ok: false, reason: "project-not-matched", projectName: input.projectName };
    }

    // Required fields — terminal, no silent fallback. The bot's legacy email
    // path handles anything this can't confidently code.
    const vendorName = (input.vendor ?? "").trim();
    if (!vendorName || vendorName.toLowerCase() === "unknown") {
        return { ok: false, reason: "missing-vendor" };
    }
    if (!isValidCalendarDate(input.date)) {
        return { ok: false, reason: "invalid-date" };
    }

    // Money validation — integer cents throughout to avoid float drift.
    // EVERY group must be finite and non-negative (the bot legitimately sends
    // zero-amount fee/tax groups, which are skipped as no-op lines; anything
    // negative or non-numeric anywhere rejects the whole document).
    const roundedGroups = input.groups.map(g => ({ ...g, cents: Math.round(Number(g.amount) * 100) }));
    if (roundedGroups.some(g => !Number.isFinite(g.cents) || g.cents < 0)) {
        return { ok: false, reason: "invalid-group-amount" };
    }
    const includedGroups = roundedGroups.filter(g => g.cents > 0);
    const groupsSumCents = includedGroups.reduce((sum, g) => sum + g.cents, 0);
    if (!Number.isFinite(input.totalAmount) || input.totalAmount <= 0) {
        return { ok: false, reason: "amount-mismatch", groupsSum: groupsSumCents / 100, totalAmount: input.totalAmount };
    }
    const totalCents = Math.round(input.totalAmount * 100);
    // A sub-cent total (rounds to 0) or an empty line set must never produce a
    // Purchase — QBO would accept a lineless/zero document.
    if (totalCents <= 0 || includedGroups.length === 0) {
        return { ok: false, reason: "amount-mismatch", groupsSum: groupsSumCents / 100, totalAmount: input.totalAmount };
    }
    if (Math.abs(groupsSumCents - totalCents) > 2) {
        return { ok: false, reason: "amount-mismatch", groupsSum: groupsSumCents / 100, totalAmount: input.totalAmount };
    }

    // Overhead docs post to the category's own expense account. The tax split
    // is refused outright: the reseller-permit reclaim covers job materials
    // only, so overhead sales tax must stay inside the expense, and silently
    // rerouting it would corrupt the state-filing report. Resolved BEFORE any
    // customer/vendor ensure so an unmatched category never creates entities.
    const overheadCategory = (input.overheadCategory ?? "").trim();
    let overheadAccountId: string | null = null;
    if (overheadCategory) {
        if (roundedGroups.some(g => g.tax === true)) {
            return { ok: false, reason: "overhead-tax-unsupported" };
        }
        overheadAccountId = await resolveOverheadAccountId(tokens, qbQueryFn, overheadCategory);
        if (!overheadAccountId) {
            return { ok: false, reason: "overhead-account-not-matched", category: overheadCategory };
        }
    }

    // Customer resolved PER PROJECT (QBO customers are named after jobs — this
    // round-trips with the expense sync's project-name matching). A Client can
    // own several projects, so Client.qbCustomerId is never used here.
    let customerId: string;
    try {
        customerId = await ensureCustomerFn(tokens, { name: project.name });
    } catch (error) {
        // ensureQBCustomer's ambiguous-duplicate rejection is deterministic —
        // terminal fallback, not a retry loop.
        if (error instanceof Error && /resolve the duplicate in QuickBooks/.test(error.message)) {
            return { ok: false, reason: "duplicate-name" };
        }
        throw error;
    }

    let vendorId: string;
    try {
        vendorId = await ensureVendorFn(tokens, vendorName);
    } catch (error) {
        if (error instanceof QboVendorDuplicateError) {
            return { ok: false, reason: "duplicate-name" };
        }
        throw error;
    }

    const bankAccountId = process.env.QBO_RECEIPT_BANK_ACCOUNT_ID || BANK_ACCOUNT_ID_DEFAULT;
    const expenseAccountId = process.env.QBO_RECEIPT_EXPENSE_ACCOUNT_ID || EXPENSE_ACCOUNT_ID_DEFAULT;
    const taxAccountId = process.env.QBO_RECEIPT_TAX_ACCOUNT_ID || TAX_ACCOUNT_ID_DEFAULT;

    const refSuffix = input.invoice
        ? ` · Invoice ${input.invoice}`
        : input.checkNumber
            ? ` · Check #${input.checkNumber}`
            : "";
    // Truncate the descriptive prefix, never the marker — a lost-response retry
    // depends on finding the FULL [gtr-file:...] marker to prove idempotency.
    const notePrefix = `${input.projectName} - ${vendorName} ($${input.totalAmount})${refSuffix}`
        .slice(0, 4000 - marker.length - 1);
    const privateNote = `${notePrefix} ${marker}`;

    const lines = includedGroups.map(g => {
        const lineDescs = (g.lines || []).slice(0, 4).map(l => l.desc).filter(Boolean).join("; ");
        const description = `${g.category}${lineDescs ? ` - ${lineDescs}` : ""}`.slice(0, 4000);
        return {
            Amount: g.cents / 100,
            DetailType: "AccountBasedExpenseLineDetail",
            Description: description,
            AccountBasedExpenseLineDetail: {
                // Tax lines post to the reimbursable-sales-tax account but stay
                // job-coded: the tax IS a job cost until the state refunds it.
                // Overhead docs (tax refused above) post to the category account.
                AccountRef: { value: g.tax ? taxAccountId : (overheadAccountId ?? expenseAccountId) },
                CustomerRef: { value: customerId },
                BillableStatus: "NotBillable",
                TaxCodeRef: { value: "NON" },
            },
        };
    });

    const payload = {
        DocNumber: docNumber,
        TxnDate: input.date,
        PaymentType: "Cash",
        AccountRef: { value: bankAccountId },
        EntityRef: { value: vendorId, type: "Vendor" },
        PrivateNote: privateNote,
        Line: lines,
    };

    // Once per process, before the first create — never write against a
    // misconfigured account.
    // The verification is SHARED across concurrent pushes, so it runs with its
    // own fixed budget; `deadline` below is only this waiter's patience.
    const verifyQueryFn = deps.qbQueryFn
        ?? (<T = any>(t: QBTokens, q: string) => qbQuery<T>(t, q, createRouteDeadline(ACCOUNT_VERIFY_BUDGET_MS)));
    await verifyReceiptAccounts(tokens, verifyQueryFn, bankAccountId, expenseAccountId, taxAccountId, deadline);

    const requestId = receiptRequestId(input.fileId);
    // Last check before the write that actually posts money. Starting it with
    // no budget left is how a Purchase gets created by a function that is then
    // killed before it can report the id — the lost-response case this whole
    // recovery path exists to clean up after.
    if (isBudgetExhausted(deadline)) {
        throw new QBBudgetExhaustedError("Route budget exhausted before the QBO Purchase create");
    }
    const created = await qbCreateFn(tokens, payload, requestId);

    let attachment: ReceiptAttachmentStatus = "skipped";
    const plan = planAttachmentUpload(input);
    if (plan) {
        try {
            attachment = await uploadAttachment(tokens, created.id, plan);
        } catch (error) {
            // Every THROWN attachment failure propagates; only the terminal
            // ones (4xx other than 429, a QBO Fault) come back as values.
            // Reporting a transient failure as `failed:<reason>` alongside
            // ok:true made it TERMINAL — the Apps Script treats any ok:true as
            // final and stops resending, so the Purchase kept its missing
            // receipt forever and the existing-Purchase recovery above never
            // ran. Propagating gives the route a 503, the bot retries, and the
            // next pass finds the Purchase and attaches the file.
            if (isQBTimeoutError(error) || isRetryableQboError(error) || isQboAttachmentAuthError(error)) throw error;
            throw new QboRetryableError(
                `QB attachment step failed: ${error instanceof Error ? error.name : "error"}`,
            );
        }
    }

    return { ok: true, qbPurchaseId: created.id, docNumber, alreadyExists: false, attachment };
}
