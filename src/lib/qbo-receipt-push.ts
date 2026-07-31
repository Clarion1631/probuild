/**
 * Push a finalized receipt/check Purchase directly into QuickBooks Online.
 * Replaces the Apps Script's email-to-QBO leg — see
 * docs/apps-script/sendToQBOviaAPI.gs — with ProBuild creating the Purchase
 * directly, job-coded at the line level, with the receipt file attached, so
 * the bank feed shows a ready match.
 *
 * QBO is the source of record and this writes to REAL BOOKS, so idempotency
 * (DocNumber = the Drive fileId, truncated) is load-bearing — a re-send of
 * the same file must never create a second Purchase.
 *
 * ensureQBVendor mirrors ensureQBCustomer in ./quickbooks.ts exactly, against
 * the Vendor entity. createQBReceiptPurchase's dependency-injection shape
 * mirrors syncQboExpenses in ./qbo-expense-sync.ts.
 */
import { prisma } from "./prisma";
import { matchProjectByName } from "./project-match";
import {
    qbFetch,
    qbQuery,
    escapeQBString,
    ensureQBCustomer,
    QB_API_BASE,
    type QBTokens,
} from "./quickbooks";

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
    date?: string; // YYYY-MM-DD
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
    | { ok: false; reason: "amount-mismatch"; groupsSum: number; totalAmount: number };

export interface QboReceiptProjectCandidate {
    id: string;
    name: string;
    client: { id: string; name: string; email: string | null; qbCustomerId: string | null };
}

export interface QboReceiptPushDependencies {
    qbQueryFn: <T = any>(tokens: QBTokens, query: string) => Promise<T[]>;
    qbCreateFn: (tokens: QBTokens, payload: Record<string, unknown>) => Promise<{ id: string }>;
    ensureVendorFn: (tokens: QBTokens, name: string) => Promise<string>;
    listProjects: () => Promise<QboReceiptProjectCandidate[]>;
    persistCustomerId: (clientId: string, qbCustomerId: string) => Promise<void>;
    uploadAttachment: (
        tokens: QBTokens,
        purchaseId: string,
        file: { base64: string; contentType: string; fileName: string },
    ) => Promise<ReceiptAttachmentStatus>;
}

const BANK_ACCOUNT_ID_DEFAULT = "154"; // Washington Trust Bank
const EXPENSE_ACCOUNT_ID_DEFAULT = "98"; // COGS Supplies & materials
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ATTACHABLE_CONTENT = /^(image\/|application\/pdf)/i;

async function defaultQbCreatePurchase(tokens: QBTokens, payload: Record<string, unknown>): Promise<{ id: string }> {
    const res = await qbFetch("/purchase", tokens, { method: "POST", body: JSON.stringify(payload) });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`QB purchase create failed: ${err}`);
    }
    const data = await res.json();
    return { id: data.Purchase.Id };
}

async function defaultListInProgressProjects(): Promise<QboReceiptProjectCandidate[]> {
    return prisma.project.findMany({
        where: { status: "In Progress" },
        select: {
            id: true,
            name: true,
            client: { select: { id: true, name: true, email: true, qbCustomerId: true } },
        },
    });
}

async function defaultPersistCustomerId(clientId: string, qbCustomerId: string): Promise<void> {
    await prisma.client.update({ where: { id: clientId }, data: { qbCustomerId } });
}

/**
 * Upload a receipt file as a QBO Attachable linked to a Purchase via the
 * multipart Attachable endpoint. Best-effort: the Purchase itself is already
 * created by the time this runs, and this never throws back out uncaught —
 * callers must still treat a thrown error as a non-fatal "failed:<reason>".
 */
async function defaultUploadAttachment(
    tokens: QBTokens,
    purchaseId: string,
    file: { base64: string; contentType: string; fileName: string },
): Promise<ReceiptAttachmentStatus> {
    const fileBytes = Buffer.from(file.base64, "base64");
    const metadata = {
        AttachableRef: [{ EntityRef: { value: purchaseId, type: "Purchase" } }],
        FileName: file.fileName,
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
            `Content-Disposition: form-data; name="file_content_01"; filename="${file.fileName}"${CRLF}` +
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
    return "attached";
}

/**
 * Create (or reuse) the finalized QBO Purchase for one receipt/check document,
 * job-coded per category group at the line level.
 *
 * Order matters: idempotency, then project match, then amount validation ALL
 * run before any QBO entity (customer/vendor) is touched, so a bad payload
 * (unmatched project, amount drift) never creates or looks up anything in
 * QuickBooks beyond the initial DocNumber query.
 */
export async function createQBReceiptPurchase(
    tokens: QBTokens,
    input: CreateQBReceiptPurchaseInput,
    deps: Partial<QboReceiptPushDependencies> = {},
): Promise<CreateQBReceiptPurchaseResult> {
    const qbQueryFn = deps.qbQueryFn ?? qbQuery;
    const qbCreateFn = deps.qbCreateFn ?? defaultQbCreatePurchase;
    const ensureVendorFn = deps.ensureVendorFn ?? ensureQBVendor;
    const listProjects = deps.listProjects ?? defaultListInProgressProjects;
    const persistCustomerId = deps.persistCustomerId ?? defaultPersistCustomerId;
    const uploadAttachment = deps.uploadAttachment ?? defaultUploadAttachment;

    const docNumber = input.fileId.slice(0, 21);

    // Idempotency first — never re-create a Purchase for a file already pushed.
    const existing = await qbQueryFn<{ Id: string }>(
        tokens,
        `SELECT Id FROM Purchase WHERE DocNumber = '${escapeQBString(docNumber)}'`,
    );
    if (existing.length > 0) {
        return { ok: true, qbPurchaseId: existing[0].Id, docNumber, alreadyExists: true };
    }

    const projects = await listProjects();
    const project = matchProjectByName(input.projectName, projects);
    if (!project) {
        return { ok: false, reason: "project-not-matched", projectName: input.projectName };
    }

    // Amount validation next — before any customer/vendor creation, so a bad
    // payload never triggers a real QBO write.
    const roundedGroups = input.groups.map(g => ({ ...g, amount: Math.round(Number(g.amount) * 100) / 100 }));
    const hasInvalidAmount = roundedGroups.some(g => !Number.isFinite(g.amount));
    const includedGroups = roundedGroups.filter(g => Number.isFinite(g.amount) && g.amount !== 0);
    const groupsSum = Math.round(includedGroups.reduce((sum, g) => sum + g.amount, 0) * 100) / 100;
    const totalProvided = Number.isFinite(input.totalAmount);
    if (
        hasInvalidAmount ||
        !(groupsSum > 0) ||
        (totalProvided && Math.abs(groupsSum - input.totalAmount) > 0.02)
    ) {
        return { ok: false, reason: "amount-mismatch", groupsSum, totalAmount: input.totalAmount };
    }

    // Customer: reuse the stored id, else resolve + persist it (same pattern
    // as resolveCustomerAndItem in quickbooks-payments.ts).
    let customerId = project.client.qbCustomerId;
    if (!customerId) {
        customerId = await ensureQBCustomer(tokens, project.client);
        await persistCustomerId(project.client.id, customerId);
    }

    // Vendor: omit EntityRef entirely for an unset/"Unknown" vendor.
    const vendorName = (input.vendor ?? "").trim();
    const vendorId =
        vendorName && vendorName.toLowerCase() !== "unknown"
            ? await ensureVendorFn(tokens, vendorName)
            : null;

    const txnDate =
        input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date)
            ? input.date
            : new Date().toISOString().slice(0, 10);

    const bankAccountId = process.env.QBO_RECEIPT_BANK_ACCOUNT_ID || BANK_ACCOUNT_ID_DEFAULT;
    const expenseAccountId = process.env.QBO_RECEIPT_EXPENSE_ACCOUNT_ID || EXPENSE_ACCOUNT_ID_DEFAULT;

    const refSuffix = input.invoice
        ? ` · Invoice ${input.invoice}`
        : input.checkNumber
            ? ` · Check #${input.checkNumber}`
            : "";
    const privateNote = `${input.projectName} - ${vendorName || "Unknown"} ($${input.totalAmount})${refSuffix} [gtr-file:${input.fileId}]`.slice(0, 4000);

    const lines = includedGroups.map(g => {
        const lineDescs = (g.lines || []).slice(0, 4).map(l => l.desc).filter(Boolean).join("; ");
        const description = `${g.category}${lineDescs ? ` - ${lineDescs}` : ""}`.slice(0, 4000);
        return {
            Amount: g.amount,
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
        TxnDate: txnDate,
        PaymentType: "Cash",
        AccountRef: { value: bankAccountId },
        ...(vendorId ? { EntityRef: { value: vendorId, type: "Vendor" } } : {}),
        PrivateNote: privateNote,
        Line: lines,
    };

    const created = await qbCreateFn(tokens, payload);

    let attachment: ReceiptAttachmentStatus = "skipped";
    if (input.fileBase64) {
        const decodedSize = Buffer.byteLength(input.fileBase64, "base64");
        const contentType = input.fileContentType || "";
        if (decodedSize <= MAX_ATTACHMENT_BYTES && ATTACHABLE_CONTENT.test(contentType)) {
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
