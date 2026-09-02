/**
 * Gemini read step — the v3.6 extraction, ported from
 * qbo-clasp/runReceiptAutomation.js analyzeDriveFileWithGemini (:1081–1236).
 *
 * The PROMPT is verbatim from :1099–1133. It is the single most load-bearing
 * string in the receipt pipeline: the final-amount rule, the never-estimate-tax
 * rule, and the multi/non_receipt triage are all decisions Marge otherwise
 * makes by hand, and each sentence in it was added after a specific misread.
 * tests/receipt-intake-read.test.ts pins those sentences so a "tidy-up" edit
 * fails loudly. ONE section is appended (the project's cost codes plus a
 * "suggested_phase" output field); the v1 extraction fields stay byte-identical.
 *
 * The retry discipline is ported too, including the distinction the Apps Script
 * learned the hard way (:1143–1184): "the service was busy" and "this document
 * defeated the AI" are DIFFERENT outcomes. Collapsing them parked five legible
 * receipts during the 2026-08-10..19 outage, because the caller spent one of the
 * file's strikes on Google's bad day.
 *
 * The model list is NOT ported — the Apps Script's is 2.5-era and 404s on this
 * key. Current working text model is "gemini-3.5-flash" (verified against
 * ListModels 2026-08-06, see src/lib/daily-log-task-match.ts:26).
 */

/**
 * ONE row's entire read budget, models and backoffs included.
 *
 * The Apps Script could afford 5 retries per model with exponential backoff
 * (2s..32s): it runs on a 6-minute trigger and only has to finish before the
 * NEXT trigger. This worker runs inside a 60-second Vercel function that has to
 * get through a batch of ten, so the same schedule would let ONE busy document
 * eat the whole invocation and starve the other nine — the outage would look
 * like a stalled queue rather than a slow one. A row that cannot be read in 25
 * seconds is not a row worth spending a whole run on; it comes back next pass
 * at no cost to itself (AI_UNAVAILABLE never spends `attempts`).
 */
export const READ_BUDGET_MS = 25_000;
/** Retries AFTER the first attempt, per model. Three fetches per model, worst case. */
const MAX_RETRIES = 2;
/** Backoff before retry 1 and retry 2. Short on purpose — see READ_BUDGET_MS. */
const RETRY_BACKOFF_MS = [1_000, 3_000];
export const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-flash-latest"];

/** One selectable phase, rendered into the prompt as "code — name". */
export interface ProjectPhase {
    code: string;
    name: string;
}

export interface ReadResult {
    /** receipt | check | multi | non_receipt */
    docType: string;
    vendor: string;
    /** As READ off the document — "" when unreadable. Callers apply the fallback. */
    date: string;
    invoice: string;
    checkNumber: string;
    memo: string;
    /** Raw model string; run it through cleanMoney before using it as money. */
    totalAmount: string;
    taxAmount: string;
    /** One of the supplied phase codes, or "". */
    suggestedPhaseCode: string;
    /** The model's raw JSON text, stored for audit. */
    raw: string;
}

export type ReadOutcome =
    | { ok: true; read: ReadResult }
    /**
     * decisive: a model ANSWERED and still could not turn this document into
     * usable data (or rejected the payload). Retrying will not change that —
     * the caller must spend an attempt and route the row to a human.
     *
     * decisive false: every model was unavailable (429, ANY 5xx, 404, 401,
     * 403, or a network error).
     * The document was never read, so the caller must NOT spend an attempt.
     */
    | { ok: false; decisive: boolean };

export interface ReadDependencies {
    fetchFn: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    apiKey: () => string | undefined;
    /** Monotonic-enough clock, injectable so the budget is testable without waiting. */
    monotonicMs: () => number;
    /** Total budget for this ONE read, across every model and backoff. */
    budgetMs: number;
}

const defaultDeps: ReadDependencies = {
    fetchFn: (...args) => fetch(...args),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    apiKey: () => process.env.GEMINI_API_KEY,
    monotonicMs: () => Date.now(),
    budgetMs: READ_BUDGET_MS,
};

/** Drive returns "text/plain; charset=utf-8" — strip parameters (:1073). */
export function normalizeMime(mime: unknown): string {
    return String(mime || "").split(";")[0].trim().toLowerCase();
}

/**
 * :1099–1133 VERBATIM, plus the appended phase section. Exported so the test
 * can assert the load-bearing sentences without a network call.
 */
export function buildReadPrompt(projectPhases: ProjectPhase[]): string {
    const promptText =
        'Role: Bookkeeper for "Golden Touch Remodeling", a residential remodeling contractor.\n' +
        "The attached document may be:\n" +
        "  A) a RECEIPT / INVOICE from a store or vendor,\n" +
        "  B) a photo of a HANDWRITTEN CHECK the business wrote to a subcontractor, or\n" +
        "  C) a NON-RECEIPT such as a payment-app screenshot, payroll advances, a bank-transfer confirmation, or a chat/text-message screenshot.\n\n" +
        'STEP 1 - if the file contains MORE THAN ONE separate receipt, invoice, or check ' +
        "(e.g. several receipts scanned into one PDF, or a sale AND its refund as separate pages), " +
        'return exactly {"doc_type":"multi"} and nothing else. A multi-PAGE document about ONE ' +
        'transaction is fine. Otherwise, for category C return exactly {"doc_type":"non_receipt"} and nothing else. ' +
        'For purchase documents set doc_type to "receipt" or "check".\n' +
        "STEP 2 - extract ONLY these fields:\n" +
        '- RECEIPT: vendor, date, invoice number (or "NoInv"), total_amount, tax_amount. ' +
        "total_amount is the FINAL amount paid — after all discounts, coupons, and credits, and " +
        "including tax and fees. It is the number that will match the bank/card charge. NEVER the " +
        "subtotal, and never the pre-discount price. If the receipt shows both a subtotal and a " +
        "total, use the total. tax_amount is the sales tax shown on the receipt (the TAX line); " +
        'return "" if no tax line is shown or it cannot be read confidently — never estimate or ' +
        "compute it yourself.\n" +
        '- CHECK: vendor = the "PAY TO THE ORDER OF" payee; date; total_amount from the numeric box ' +
        "(cross-check it against the written-out amount line); check_number (printed top-right); " +
        'memo (the handwritten bottom-left "MEMO"/"FOR" line — what the payment is for). ' +
        "Handwriting may be messy — read carefully.\n" +
        'If a field cannot be read, return "" for it. For the date, return "" rather than guessing.\n\n' +
        "OUTPUT FORMAT (Strict JSON):\n" +
        "{\n" +
        '  "doc_type": "receipt, check, multi, or non_receipt",\n' +
        '  "vendor": "String (payee for checks)",\n' +
        '  "date": "YYYY-MM-DD or empty",\n' +
        '  "invoice": "String (or NoInv)",\n' +
        '  "check_number": "String (checks only)",\n' +
        '  "memo": "String (checks only, verbatim memo line)",\n' +
        '  "total_amount": "0.00",\n' +
        '  "tax_amount": "0.00 (receipts only, empty if not shown)"\n' +
        "}";

    // The ONE appended section. A suggestion only — a human or the cost-code
    // matcher still owns the final phase, so an empty answer is always allowed
    // and an off-list answer is discarded by the caller.
    if (projectPhases.length === 0) return promptText;
    const phaseList = projectPhases.map(p => `${p.code} — ${p.name}`).join("\n");
    return (
        promptText +
        "\n\nSTEP 3 - this document belongs to a job with the following phases:\n" +
        phaseList +
        "\nAdd ONE more output field, \"suggested_phase\", holding the CODE of the single phase " +
        "this purchase most clearly belongs to. Use only a code from the list above, exactly as " +
        'written. If nothing on the document points clearly at one phase, return "".'
    );
}

function coerce(value: unknown): string {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

/** Map the model's JSON onto ReadResult; off-list phase suggestions are dropped. */
export function parseReadJson(text: string, projectPhases: ProjectPhase[]): ReadResult | null {
    let json: Record<string, unknown>;
    try {
        json = JSON.parse(text);
    } catch {
        return null;
    }
    if (!json || typeof json !== "object") return null;

    const allowed = new Set(projectPhases.map(p => p.code));
    const suggested = coerce(json.suggested_phase);

    return {
        docType: (coerce(json.doc_type) || "receipt").toLowerCase(),
        vendor: coerce(json.vendor),
        date: coerce(json.date),
        invoice: coerce(json.invoice),
        checkNumber: coerce(json.check_number),
        memo: coerce(json.memo),
        totalAmount: coerce(json.total_amount),
        taxAmount: coerce(json.tax_amount),
        suggestedPhaseCode: allowed.has(suggested) ? suggested : "",
        raw: text,
    };
}

/**
 * Read one document. `fileBytes` is the raw file; text/plain goes in as a text
 * part the way v1 does (:1093), everything else as inline_data.
 */
export async function readReceipt(
    fileBytes: Buffer,
    mime: string,
    projectPhases: ProjectPhase[],
    deps: Partial<ReadDependencies> = {},
): Promise<ReadOutcome> {
    const { fetchFn, sleep, apiKey, monotonicMs, budgetMs } = { ...defaultDeps, ...deps };
    const key = apiKey();
    // No key configured is a SERVICE fact, not a document fact — never spend
    // the row's attempts on it.
    if (!key) return { ok: false, decisive: false };

    const mimeType = normalizeMime(mime);
    const payloadPart = mimeType === "text/plain"
        ? { text: "This is a text file containing receipt data:\n" + fileBytes.toString("utf8") }
        : { inline_data: { mime_type: mimeType, data: fileBytes.toString("base64") } };

    const body = JSON.stringify({
        contents: [{ parts: [{ text: buildReadPrompt(projectPhases) }, payloadPart] }],
        generationConfig: { responseMimeType: "application/json" },
    });

    // A definitive failure OUTRANKS an availability one: if any model got a
    // response and still could not produce usable JSON, that is evidence about
    // the DOCUMENT, and treating it as "busy" would retry a hopeless file
    // forever.
    let sawDecisiveFailure = false;

    const startedAt = monotonicMs();
    const remaining = () => budgetMs - (monotonicMs() - startedAt);

    for (const model of GEMINI_MODELS) {
        const url =
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
            `:generateContent?key=${encodeURIComponent(key)}`;
        let attempts = 0;

        for (;;) {
            // The budget is checked before every network call AND before every
            // sleep, so an exhausted budget can never be discovered only after
            // the call that blew it.
            if (remaining() <= 0) break;

            let response: Response;
            try {
                response = await fetchFn(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body,
                    // Never outlive the row's budget: a single hung socket must
                    // not consume the worker's whole invocation.
                    signal: AbortSignal.timeout(remaining()),
                });
            } catch {
                // Network error / our own abort. Both are SERVICE facts.
                if (attempts >= MAX_RETRIES) break;
                const wait = RETRY_BACKOFF_MS[attempts];
                attempts++;
                if (remaining() <= wait) break;
                await sleep(wait);
                continue;
            }

            const code = response.status;

            if (code === 200) {
                const json = await response.json().catch(() => null) as
                    { candidates?: { content?: { parts?: { text?: string }[] } }[] } | null;
                const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
                // The model answered; it just could not turn THIS document into
                // usable data. Try the next model, then give up decisively.
                if (!text) { sawDecisiveFailure = true; break; }
                const parsed = parseReadJson(text, projectPhases);
                if (parsed) return { ok: true, read: parsed };
                sawDecisiveFailure = true;
                break;
            }

            // EVERY 5xx is the SERVICE failing, not the document. 503 and 429
            // were already treated that way, but 500/502/504 fell through to
            // the "decisive" branch below and charged the row a strike for a
            // Google-side fault it had nothing to do with — precisely the
            // mistake the outage rationale at :1143-1184 exists to prevent. A
            // gateway error says nothing about whether the receipt is readable.
            if (code === 429 || code >= 500) { // overloaded / rate-limited / server fault
                if (attempts >= MAX_RETRIES) break; // fall through to the next model
                const wait = RETRY_BACKOFF_MS[attempts];
                attempts++;
                if (remaining() <= wait) break;
                await sleep(wait);
                continue;
            }

            // 404 (model not available for this key) and 401/403 (revoked key,
            // blocked project) are SERVICE failures: the document was never
            // read, so they must not cost this row an attempt. A 404 on ONE
            // model while another works is exactly what the chain is for.
            if (code === 404 || code === 401 || code === 403) break;

            // What is left is a 4xx that is not 401/403/404/429: a rejected
            // payload (400 = oversized or undecodable). THAT is about this
            // document, and no amount of retrying changes it.
            sawDecisiveFailure = true;
            return { ok: false, decisive: true };
        }

        // The budget, not this model, is what ended the loop — trying the next
        // model would only overrun it further.
        if (remaining() <= 0) break;
    }

    // Budget exhausted, or every model was unavailable: AI_UNAVAILABLE. A
    // decisive failure still outranks it — if some model DID answer and could
    // not read the document, that is a fact about the document and the caller
    // must spend an attempt on it.
    return { ok: false, decisive: sawDecisiveFailure };
}
