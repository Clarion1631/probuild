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
    type QBTokens,
} from "./quickbooks";

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
export async function ensureQBVendor(tokens: QBTokens, name: string): Promise<string> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Vendor name is empty — cannot sync vendor to QuickBooks.");

    const byName = await qbQuery(tokens, `SELECT Id FROM Vendor WHERE DisplayName = '${escapeQBString(trimmed)}'`);
    if (byName.length > 0) return byName[0].Id;

    // QBO normalizes whitespace when enforcing DisplayName uniqueness, so an
    // exact match can miss while create still rejects as a duplicate (fault 6240).
    // Prefix on the first word only, so internal-whitespace variants still match.
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const prefix = trimmed.split(/\s+/)[0];
    const candidates = await qbQuery<{ Id: string; DisplayName?: string }>(
        tokens,
        `SELECT Id, DisplayName FROM Vendor WHERE DisplayName LIKE '${escapeQBString(prefix)}%' MAXRESULTS 1000`
    );
    const matches = candidates.filter(c => normalize(c.DisplayName ?? "") === normalize(trimmed));
    if (matches.length > 1) {
        throw new Error(`QB vendor lookup for "${trimmed}" matched ${matches.length} vendors — resolve the duplicate in QuickBooks.`);
    }
    if (matches.length === 1) return matches[0].Id;

    const res = await qbFetch("/vendor", tokens, {
        method: "POST",
        body: JSON.stringify({ DisplayName: trimmed }),
    });
    if (!res.ok) {
        const err = await res.text();
        if (err.includes("6240")) {
            // A concurrent create can win the race between our lookup and our
            // create — re-query once rather than assuming the duplicate is gone.
            const requery = await qbQuery(tokens, `SELECT Id FROM Vendor WHERE DisplayName = '${escapeQBString(trimmed)}'`);
            if (requery.length > 0) return requery[0].Id;
            throw new QboVendorDuplicateError(trimmed);
        }
        throw new Error(`QB vendor create failed: ${err}`);
    }
    const data = await res.json();
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
}

/** "attached" | "skipped" | "failed:<short reason>" — a failure never fails the Purchase create. */
export type ReceiptAttachmentStatus = "attached" | "skipped" | `failed:${string}`;

export type CreateQBReceiptPurchaseResult =
    | { ok: true; qbPurchaseId: string; docNumber: string; alreadyExists: true }
    | { ok: true; qbPurchaseId: string; docNumber: string; alreadyExists: false; attachment: ReceiptAttachmentStatus }
    | { ok: false; reason: "project-not-matched"; projectName: string }
    | { ok: false; reason: "docnumber-conflict"; docNumber: string }
    | { ok: false; reason: "invalid-group-amount" }
    | { ok: false; reason: "amount-mismatch"; groupsSum: number; totalAmount: number }
    | { ok: false; reason: "missing-vendor" }
    | { ok: false; reason: "invalid-date" }
    | { ok: false; reason: "duplicate-name" };

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
}

const BANK_ACCOUNT_ID_DEFAULT = "154"; // Washington Trust Bank
const EXPENSE_ACCOUNT_ID_DEFAULT = "98"; // COGS Supplies & materials
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

function isAttachableContentType(contentType: string): boolean {
    return /^image\//i.test(contentType) || contentType.toLowerCase() === "application/pdf";
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
): Promise<{ id: string }> {
    const res = await qbFetch(`/purchase?requestid=${encodeURIComponent(requestId)}`, tokens, {
        method: "POST",
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
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
    const data = await res.json();
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
async function defaultUploadAttachment(
    tokens: QBTokens,
    purchaseId: string,
    file: { base64: string; contentType: string; fileName: string },
): Promise<ReceiptAttachmentStatus> {
    // Strip CR/LF/quotes so the name can't break out of the multipart header line.
    const safeFileName = file.fileName.replace(/[\r\n"]/g, "") || "receipt";
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

    const res = await fetch(`${QB_API_BASE}/${tokens.realmId}/upload?minorversion=73`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: "application/json",
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
    });
    if (!res.ok) return `failed:${res.status}`;
    const data = await res.json().catch(() => null);
    const fault = data?.AttachableResponse?.[0]?.Fault;
    if (fault) return "failed:fault";
    return "attached";
}

/**
 * Verify the configured bank/expense accounts are what they claim to be, once
 * per process, before the first Purchase create. A mismatch means the env is
 * misconfigured (wrong account id after a QBO chart-of-accounts change, wrong
 * realm, ...) — this must throw and never let a Purchase post against the
 * wrong account.
 */
let verifiedAccountsPromise: Promise<void> | null = null;

async function verifyReceiptAccounts(
    tokens: QBTokens,
    qbQueryFn: QboReceiptPushDependencies["qbQueryFn"],
    bankAccountId: string,
    expenseAccountId: string,
): Promise<void> {
    if (!verifiedAccountsPromise) {
        verifiedAccountsPromise = (async () => {
            const [bankRows, expenseRows] = await Promise.all([
                qbQueryFn<{ Id: string; Name?: string; AccountType?: string }>(
                    tokens,
                    `SELECT Id, Name, AccountType FROM Account WHERE Id = '${escapeQBString(bankAccountId)}'`,
                ),
                qbQueryFn<{ Id: string; Name?: string; AccountType?: string }>(
                    tokens,
                    `SELECT Id, Name, AccountType FROM Account WHERE Id = '${escapeQBString(expenseAccountId)}'`,
                ),
            ]);
            const bank = bankRows[0];
            const expense = expenseRows[0];
            const bankOk = !!bank && bank.AccountType === "Bank" && /Washington Trust/i.test(bank.Name ?? "");
            const expenseOk = !!expense && expense.AccountType === "Cost of Goods Sold";
            if (!bankOk || !expenseOk) {
                throw new Error(
                    `QBO receipt push is misconfigured: bank account ${bankAccountId} is ` +
                    `${bank?.AccountType ?? "missing"}/"${bank?.Name ?? "missing"}" (need Bank/"Washington Trust"); ` +
                    `expense account ${expenseAccountId} is ${expense?.AccountType ?? "missing"} (need Cost of Goods Sold).`,
                );
            }
        })();
    }
    return verifiedAccountsPromise;
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
): Promise<CreateQBReceiptPurchaseResult> {
    const qbQueryFn = deps.qbQueryFn ?? qbQuery;
    const qbCreateFn = deps.qbCreateFn ?? defaultQbCreatePurchase;
    const ensureVendorFn = deps.ensureVendorFn ?? ensureQBVendor;
    const ensureCustomerFn = deps.ensureCustomerFn ?? ensureQBCustomer;
    const listProjects = deps.listProjects ?? defaultListInProgressProjects;
    const uploadAttachment = deps.uploadAttachment ?? defaultUploadAttachment;

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
        return { ok: true, qbPurchaseId: existing[0].Id, docNumber, alreadyExists: true };
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
    const roundedGroups = input.groups.map(g => ({ ...g, cents: Math.round(Number(g.amount) * 100) }));
    const includedGroups = roundedGroups.filter(g => g.cents !== 0);
    if (includedGroups.some(g => !Number.isFinite(g.cents) || g.cents <= 0)) {
        return { ok: false, reason: "invalid-group-amount" };
    }
    const groupsSumCents = includedGroups.reduce((sum, g) => sum + g.cents, 0);
    if (!Number.isFinite(input.totalAmount) || input.totalAmount <= 0) {
        return { ok: false, reason: "amount-mismatch", groupsSum: groupsSumCents / 100, totalAmount: input.totalAmount };
    }
    const totalCents = Math.round(input.totalAmount * 100);
    if (Math.abs(groupsSumCents - totalCents) > 2) {
        return { ok: false, reason: "amount-mismatch", groupsSum: groupsSumCents / 100, totalAmount: input.totalAmount };
    }

    // Customer resolved PER PROJECT (QBO customers are named after jobs — this
    // round-trips with the expense sync's project-name matching). A Client can
    // own several projects, so Client.qbCustomerId is never used here.
    const customerId = await ensureCustomerFn(tokens, { name: project.name });

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

    const refSuffix = input.invoice
        ? ` · Invoice ${input.invoice}`
        : input.checkNumber
            ? ` · Check #${input.checkNumber}`
            : "";
    const privateNote = `${input.projectName} - ${vendorName} ($${input.totalAmount})${refSuffix} ${marker}`.slice(0, 4000);

    const lines = includedGroups.map(g => {
        const lineDescs = (g.lines || []).slice(0, 4).map(l => l.desc).filter(Boolean).join("; ");
        const description = `${g.category}${lineDescs ? ` - ${lineDescs}` : ""}`.slice(0, 4000);
        return {
            Amount: g.cents / 100,
            DetailType: "AccountBasedExpenseLineDetail",
            Description: description,
            AccountBasedExpenseLineDetail: {
                AccountRef: { value: expenseAccountId },
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
    await verifyReceiptAccounts(tokens, qbQueryFn, bankAccountId, expenseAccountId);

    const requestId = receiptRequestId(input.fileId);
    const created = await qbCreateFn(tokens, payload, requestId);

    let attachment: ReceiptAttachmentStatus = "skipped";
    if (input.fileBase64) {
        const contentType = input.fileContentType || "";
        if (
            isAttachableContentType(contentType) &&
            isValidBase64(input.fileBase64) &&
            Buffer.byteLength(input.fileBase64, "base64") <= MAX_ATTACHMENT_BYTES
        ) {
            try {
                attachment = await uploadAttachment(tokens, created.id, {
                    base64: input.fileBase64,
                    contentType,
                    fileName: input.fileName || "receipt",
                });
            } catch (error) {
                attachment = `failed:${error instanceof Error ? error.name : "error"}`;
            }
        }
    }

    return { ok: true, qbPurchaseId: created.id, docNumber, alreadyExists: false, attachment };
}
