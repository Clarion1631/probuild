// Extract WHO PAID US from check/deposit images via Gemini Vision.
//
// A WTB inbound line says only "OTHER DEPOSITS DEPOSIT - DDA/MMKT". The image
// is the only evidence naming the payer, and the memo line often names the
// job. This reads BankImage rows (kind CHECK_FRONT / DEPOSIT_SLIP /
// DEPOSIT_PHOTO by default) that have not been extracted yet, sends each
// image to Gemini
// Vision, and stores ONLY payerName + memoText (+ extractedAt +
// extractionModel) via scripts/apply-check-payer-extraction.mjs's columns.
//
// ── HARD PRIVACY RULE ────────────────────────────────────────────────────
// The MICR line / routing number / account number are NEVER extracted,
// NEVER stored, NEVER printed. This is enforced twice:
//   1. The prompt forbids reading the bottom MICR strip at all.
//   2. scrubExtraction() drops ANY field whose digit content — after
//      collapsing EVERY common separator (space dash dot slash comma parens)
//      AND interleaved letters — totals 8 or more digits and is not the known
//      check number or amount, and logs a warning. Recognizable calendar
//      dates (ISO 2026-08-13 / US 8/13/2026) are exempted before counting.
// A field dropped by layer 2 also flips needsReview: --commit then stores
// NULL for payerName AND memoText on that row (extractedAt/extractionModel
// still set so replay skips it) and logs the row for human review.
// Do not weaken either layer. Do not add columns for these values.
// ─────────────────────────────────────────────────────────────────────────
//
// IDEMPOTENT: rows with extractedAt NOT NULL are skipped. Re-running is a
// no-op for already-extracted images.
//
//   node scripts/extract-check-payers.mjs --dry-run                # default; nothing written
//   node scripts/extract-check-payers.mjs --dry-run --from-manifest # pre-DDL test straight from the Drive manifest
//   node scripts/extract-check-payers.mjs --commit --limit 10      # write results (requires the DDL applied)
//   node scripts/extract-check-payers.mjs --report                 # REVIEW REPORT only: suggest payer→Client / memo→Project matches
//
// The REVIEW REPORT is print-only. It NEVER writes BankImageMatch — that
// table means a HUMAN said yes (see prisma/schema.prisma). Beverly/Justin
// confirm matches; this script only suggests.
//
// DATABASE_URL / GEMINI_API_KEY come from the environment or .env.local,
// never argv.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGES_DIR =
    "I:/My Drive/2025 Reconciliation/Washington Trust Bank/Check Images";
export const MANIFEST_PATH = path.join(IMAGES_DIR, "_manifest.json");

export const GEMINI_MODEL = "gemini-3-flash-preview";
// DEPOSIT_SLIP is included because scripts/post-bank-images.mjs assigns the
// FRONT image of every branch deposit (no check number) the kind
// DEPOSIT_SLIP, not DEPOSIT_PHOTO — for those deposits the "front" IS the
// substitute check image that names the payer, so leaving DEPOSIT_SLIP out
// of the default silently skips the exact images that carry the payer.
export const DEFAULT_KINDS = ["CHECK_FRONT", "DEPOSIT_SLIP", "DEPOSIT_PHOTO"];
export const ALL_KINDS = ["CHECK_FRONT", "CHECK_BACK", "DEPOSIT_SLIP", "DEPOSIT_PHOTO"];
export const DEFAULT_LIMIT = 25;

// ── env ──────────────────────────────────────────────────────────────────
export function resolveEnv(name) {
    if (process.env[name]) return process.env[name];
    for (const file of [".env.local", ".env"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(new RegExp(`^${name}\\s*=\\s*"?([^"\\r\\n]+)"?`, "m"));
        if (match) return match[1];
    }
    return null;
}

// ── MICR / routing / account guard ───────────────────────────────────────
// Routing numbers are 9 digits; account numbers 8-12+. A check number is
// short (typically 3-5 digits) and the amount's digit string is 3-7. So any
// candidate run whose TOTAL digit count reaches 8 — after stripping every
// common separator (space, dash, dot, slash, comma, parens) AND interleaved
// letters — is treated as banked-number leakage unless the digit string is
// explicitly allowed, and the WHOLE field is dropped. Consecutive-run-only
// checks are NOT enough: "1234 5678", "123.456.789", "123/456/789" and
// "A1B2C3D4E5F6G7H8" all hide an account/routing number without ever showing
// 8 consecutive digits.
export const BANNED_DIGIT_RUN = /\d{8,}/g; // kept for reference/compat; superseded by the total-count rule below
export const BANNED_TOTAL_DIGITS = 8;
const MICR_SYMBOLS = /[\u2446\u2447\u2448\u2449]/; // ⑆⑇⑈⑉ MICR transit/on-us glyphs

// Plausible calendar dates are exempt from digit counting (an ISO date is 8
// digits and must survive). Month/day ranges are validated so an account
// disguised as "12/34/5678" does NOT qualify.
const ISO_DATE = /\b(?:19|20)\d{2}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])\b/g;
const US_DATE = /\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)?\d{2}\b/g;

// A candidate token run: maximal chunk of letters/digits joined by the
// common separators. Letters are included so "A1B2C3D4E5F6G7H8" is one run.
const TOKEN_RUN = /[0-9A-Za-z][0-9A-Za-z\s\-./,()]*/g;

/**
 * Pure. Returns { value, dropped, truncated } — dropped is a reason string
 * when the field was discarded; truncated is true when maxLen was applied.
 * `allow` lists digit strings that are legitimately long (never expected in
 * practice, but the check number is allowed on principle: it is already
 * stored openly on the row). The allow check runs on the SEPARATOR-STRIPPED
 * digit string, so an allowed "12345678" also covers "1234 5678".
 *
 * @param {unknown} value
 * @param {string[]} [allow]
 * @param {number | null} [maxLen]
 */
export function scrubField(value, allow = [], maxLen = null) {
    if (value === null || value === undefined) return { value: null, dropped: null, truncated: false };
    const text = String(value).trim();
    if (!text) return { value: null, dropped: null, truncated: false };
    if (MICR_SYMBOLS.test(text)) {
        return { value: null, dropped: "contains MICR symbols", truncated: false };
    }
    // Blank out plausible calendar dates, then count TOTAL digits per token
    // run after stripping ALL non-digits (separators and letters alike).
    const dateless = text.replace(ISO_DATE, " ").replace(US_DATE, " ");
    const banned = (dateless.match(TOKEN_RUN) ?? [])
        .map(run => run.replace(/\D/g, ""))
        .filter(digits => digits.length >= BANNED_TOTAL_DIGITS && !allow.includes(digits));
    if (banned.length) {
        return {
            value: null,
            dropped: `contains ${banned.length} banned digit run(s) (routing/account pattern)`,
            truncated: false,
        };
    }
    if (maxLen !== null && text.length > maxLen) {
        return { value: text.slice(0, maxLen).trimEnd(), dropped: null, truncated: true };
    }
    return { value: text, dropped: null, truncated: false };
}

export const PAYER_NAME_MAX = 120;
export const MEMO_TEXT_MAX = 200;

/**
 * Pure. Scrubs a raw Gemini response into the ONLY values we keep:
 * payerName and memoText. Everything else (date, amount, check number) is
 * used for cross-check logging only and is never stored by this script.
 *
 * Length caps: payerName 120 chars, memoText 200 chars — anything longer is
 * truncated and flagged (a real name/memo line never approaches these; an
 * overrun means the model transcribed something it shouldn't have).
 *
 * needsReview is true when ANY field was dropped or truncated: the caller
 * must then store NULL for payerName/memoText and log for human review
 * instead of trusting the surviving values.
 *
 * @param {Record<string, unknown> | null | undefined} raw
 * @param {{ checkNumber?: string | null, amountCents?: number | null }} [opts]
 */
export function scrubExtraction(raw, { checkNumber = null, amountCents = null } = {}) {
    const allow = [];
    if (checkNumber) allow.push(String(checkNumber).replace(/\D/g, ""));
    if (amountCents !== null && amountCents !== undefined) allow.push(String(amountCents));

    const warnings = [];
    let needsReview = false;
    const take = (field, maxLen = null) => {
        const { value, dropped, truncated } = scrubField(raw?.[field], allow, maxLen);
        if (dropped) {
            warnings.push(`${field} DROPPED: ${dropped}`);
            needsReview = true;
        }
        if (truncated) {
            warnings.push(`${field} TRUNCATED to ${maxLen} chars`);
            needsReview = true;
        }
        return value;
    };

    const payerName = take("payerName", PAYER_NAME_MAX);
    const memoText = take("memoText", MEMO_TEXT_MAX);
    // Cross-check-only fields go through the same guard so a leaked account
    // number can never even reach a console.log.
    const documentDate = take("documentDate");
    const amount = take("amount");
    const checkNo = take("checkNumber");

    return { payerName, memoText, documentDate, amount, checkNumber: checkNo, warnings, needsReview };
}

// ── Gemini Vision (repo's REST pattern, src/lib/actions.ts aiGeneratePunchlist) ──
const EXTRACTION_PROMPT = `You are reading ONE side of a bank document (a check front or a deposit photo) for a construction company's bookkeeping.

Extract ONLY these fields:
- payerName: the person or company name printed in the top-left name/address block (who wrote the check). Name only — no street address.
- documentDate: the written or printed date, as YYYY-MM-DD.
- amount: the dollar amount from the courtesy box, e.g. "6037.15".
- memoText: the handwriting or print on the "memo" / "for" line, or null if blank.
- checkNumber: the check number from the TOP RIGHT corner ONLY.

ABSOLUTE PROHIBITION — read carefully:
Do NOT read, extract, transcribe, or output the MICR line: the row of numbers printed along the BOTTOM edge of the check in magnetic ink. That includes the routing number, the bank account number, and any number printed between ⑆ ⑈ ⑉ symbols. Never output any number with 8 or more consecutive digits from the bottom strip of the document, in any field. If you cannot fill a field without using the bottom strip, output null for that field. This is a privacy requirement and overrides completeness.

Return ONLY a JSON object, nothing else:
{"payerName": string|null, "documentDate": string|null, "amount": string|null, "memoText": string|null, "checkNumber": string|null}`;

/**
 * Scan `text` for the first balanced top-level `{...}` object — tracking
 * brace depth while respecting string literals (quotes and backslash
 * escapes) so a brace inside a string value never throws off the count.
 * Returns the substring, or null if no balanced object is found.
 *
 * @param {string} text
 * @returns {string | null}
 */
function extractFirstBalancedObject(text) {
    const start = text.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === "\\") {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === "{") {
            depth++;
        } else if (ch === "}") {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

/**
 * Pure. Parse a model response as JSON, tolerating a ```json ... ``` (or
 * bare ```) fence wrapper — models sometimes emit fences even with
 * responseMimeType: application/json. Also tolerates stray prose before
 * and/or after the JSON object: if a straight JSON.parse fails, falls back
 * to extracting the first balanced top-level `{...}` object and parsing
 * that. Rethrows the original parse error when no such object exists.
 */
export function parseModelJson(rawText) {
    let text = String(rawText ?? "").trim();
    const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
    if (fenced) text = fenced[1].trim();
    try {
        return JSON.parse(text);
    } catch (err) {
        const candidate = extractFirstBalancedObject(text);
        if (candidate === null) throw err;
        return JSON.parse(candidate);
    }
}

export async function extractViaGemini(apiKey, imageBytes, mime) {
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: EXTRACTION_PROMPT },
                        { inline_data: { mime_type: mime || "image/jpeg", data: imageBytes.toString("base64") } },
                    ],
                }],
                generationConfig: { temperature: 0, responseMimeType: "application/json" },
            }),
        },
    );
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error("No AI response");
    return parseModelJson(rawText);
}

// ── fuzzy matching for the REVIEW REPORT ─────────────────────────────────
const NAME_NOISE = new Set(["llc", "inc", "co", "corp", "ltd", "the", "and", "&", "of", "mr", "mrs", "ms", "dr", "or"]);

export function nameTokens(s) {
    return String(s ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(t => t && !NAME_NOISE.has(t));
}

/** Pure. 0..1 similarity: token-set Jaccard plus a containment bonus. */
export function nameSimilarity(a, b) {
    const ta = nameTokens(a), tb = nameTokens(b);
    if (!ta.length || !tb.length) return 0;
    const sa = new Set(ta), sb = new Set(tb);
    const inter = [...sa].filter(t => sb.has(t)).length;
    const union = new Set([...sa, ...sb]).size;
    const jaccard = inter / union;
    const containment = inter / Math.min(sa.size, sb.size);
    return Math.max(jaccard, containment * 0.85);
}

/**
 * Pure. Suggest candidate matches for one extraction. Returns
 * { payerMatches: [{id,name,score}], memoMatches: [...] } sorted by score,
 * top 3 each, threshold 0.4. Suggestion only — the caller must NEVER write
 * BankImageMatch from this.
 */
export function suggestMatches({ payerName, memoText }, clients, projects) {
    const rank = (text, rows) => rows
        .map(r => ({ id: r.id, name: r.name, score: nameSimilarity(text, r.name) }))
        .filter(m => m.score >= 0.4)
        .sort((x, y) => y.score - x.score)
        .slice(0, 3);
    return {
        payerMatches: payerName ? rank(payerName, clients) : [],
        memoMatches: memoText ? rank(memoText, projects) : [],
    };
}

// ── candidate loading ────────────────────────────────────────────────────
function parseKinds() {
    const idx = process.argv.indexOf("--kinds");
    if (idx < 0) return DEFAULT_KINDS;
    const kinds = String(process.argv[idx + 1] ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const bad = kinds.filter(k => !ALL_KINDS.includes(k));
    if (bad.length) throw new Error(`Unknown kind(s): ${bad.join(", ")}. Allowed: ${ALL_KINDS.join(", ")}`);
    return kinds;
}

function parseLimit() {
    const idx = process.argv.indexOf("--limit");
    if (idx < 0) return DEFAULT_LIMIT;
    const n = Number(process.argv[idx + 1]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--limit must be a positive integer, got "${process.argv[idx + 1]}"`);
    return n;
}

async function hasExtractionColumns(prisma) {
    const rows = await prisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='BankImage'
           AND column_name IN ('payerName','memoText','extractedAt','extractionModel')`,
    );
    return rows.length === 4;
}

async function loadCandidatesFromDb(prisma, kinds, limit, columnsReady) {
    // kinds is validated against ALL_KINDS above, limit is a checked integer —
    // safe to inline. extractedAt only exists after the DDL is applied; before
    // that, dry-run falls back to "everything is unextracted".
    const kindList = kinds.map(k => `'${k}'`).join(",");
    const where = columnsReady ? `AND "extractedAt" IS NULL` : "";
    return prisma.$queryRawUnsafe(
        `SELECT "id", "kind", "sourceExternalId", "fileName", "mime",
                "normalizedCheckNumber", "amountCents", "documentDate"
         FROM "BankImage"
         WHERE "kind" IN (${kindList}) ${where}
         ORDER BY "capturedAt" ASC
         LIMIT ${limit}`,
    );
}

/** Pre-DDL escape hatch: derive candidates straight from the Drive manifest. */
export function loadCandidatesFromManifest(manifest, kinds, limit) {
    const rows = [];
    for (const entry of Object.values(manifest.images ?? {})) {
        const files = Array.isArray(entry.files) ? entry.files : [];
        const isCheck = !!String(entry.checkNumber ?? "").replace(/\D/g, "").replace(/^0+/, "");
        files.forEach((f, i) => {
            const kind = isCheck
                ? (f.side === "front" || i === 0 ? "CHECK_FRONT" : "CHECK_BACK")
                : (i === 0 ? "DEPOSIT_SLIP" : "DEPOSIT_PHOTO");
            if (!kinds.includes(kind)) return;
            rows.push({
                id: `manifest:${entry.bankReference}:${f.side ?? `img${i + 1}`}`,
                kind,
                sourceExternalId: `${entry.bankReference}:${f.side ?? `img${i + 1}`}`,
                fileName: f.fileName,
                mime: "image/jpeg",
                normalizedCheckNumber: isCheck ? String(entry.checkNumber).replace(/\D/g, "").replace(/^0+/, "") : null,
                amountCents: entry.amountCents ?? null,
                documentDate: null,
            });
        });
    }
    return rows.slice(0, limit);
}

// ── review report ────────────────────────────────────────────────────────
function printReviewReport(results, clients, projects) {
    console.log("\n════════ REVIEW REPORT — suggestions only, NOTHING written ════════");
    console.log("BankImageMatch is human-confirmation-only; confirm in the app, not here.\n");
    let any = false;
    for (const r of results) {
        if (!r.payerName && !r.memoText) continue;
        const { payerMatches, memoMatches } = suggestMatches(r, clients, projects);
        any = true;
        console.log(`  ${r.sourceExternalId} (${r.kind}${r.normalizedCheckNumber ? `, chk#${r.normalizedCheckNumber}` : ""})`);
        console.log(`    payer: ${r.payerName ?? "(none)"} | memo: ${r.memoText ?? "(none)"}`);
        if (payerMatches.length) {
            for (const m of payerMatches) console.log(`      payer → Client  "${m.name}"  score ${m.score.toFixed(2)}  [${m.id}]`);
        } else console.log("      payer → no Client match ≥ 0.40");
        if (r.memoText) {
            if (memoMatches.length) {
                for (const m of memoMatches) console.log(`      memo  → Project "${m.name}"  score ${m.score.toFixed(2)}  [${m.id}]`);
            } else console.log("      memo  → no Project match ≥ 0.40");
        }
        console.log("");
    }
    if (!any) console.log("  (no extracted payer/memo values to match)\n");
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
    const commit = process.argv.includes("--commit");
    const reportOnly = process.argv.includes("--report") && !commit;
    const dryRun = !commit;
    const fromManifest = process.argv.includes("--from-manifest");
    const kinds = parseKinds();
    const limit = parseLimit();

    if (fromManifest && commit) {
        console.error("--from-manifest is a pre-DDL dry-run aid; it cannot be combined with --commit.");
        process.exit(1);
    }

    const dbUrl = resolveEnv("DATABASE_URL");
    if (!dbUrl && !fromManifest) {
        console.error("DATABASE_URL not found (env, .env.local, .env).");
        process.exit(1);
    }
    const prisma = dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : null;

    try {
        // ── report-only mode reads already-extracted rows and exits ──
        if (reportOnly && !fromManifest) {
            if (!prisma) throw new Error("Report mode needs a database connection.");
            const columnsReady = await hasExtractionColumns(prisma);
            if (!columnsReady) {
                console.error("Extraction columns not applied yet — run scripts/apply-check-payer-extraction.mjs first.");
                process.exit(1);
            }
            const rows = await prisma.$queryRawUnsafe(
                `SELECT "id", "kind", "sourceExternalId", "normalizedCheckNumber", "payerName", "memoText"
                 FROM "BankImage" WHERE "extractedAt" IS NOT NULL ORDER BY "capturedAt" ASC LIMIT ${limit}`,
            );
            const clients = await prisma.$queryRawUnsafe(`SELECT "id", "name" FROM "Client"`);
            const projects = await prisma.$queryRawUnsafe(`SELECT "id", "name" FROM "Project"`);
            console.log(`report: ${rows.length} extracted image(s), ${clients.length} client(s), ${projects.length} project(s)`);
            printReviewReport(rows, clients, projects);
            return;
        }

        // ── candidate selection ──
        let candidates;
        let columnsReady = false;
        if (fromManifest) {
            if (!fs.existsSync(MANIFEST_PATH)) {
                console.error(`No manifest at ${MANIFEST_PATH}`);
                process.exit(1);
            }
            const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
            candidates = loadCandidatesFromManifest(manifest, kinds, limit);
            console.log(`manifest: ${candidates.length} candidate image(s) [kinds: ${kinds.join(", ")}]`);
        } else {
            columnsReady = await hasExtractionColumns(prisma);
            if (!columnsReady) {
                if (commit) {
                    console.error("Extraction columns missing — apply scripts/apply-check-payer-extraction.mjs before --commit.");
                    process.exit(1);
                }
                console.log("NOTE: extraction columns not applied yet; dry-run treats every row as unextracted.");
            }
            candidates = await loadCandidatesFromDb(prisma, kinds, limit, columnsReady);
            console.log(`db: ${candidates.length} unextracted image(s) [kinds: ${kinds.join(", ")}, limit ${limit}]`);
        }

        if (!candidates.length) {
            console.log("Nothing to extract.");
            return;
        }

        const apiKey = resolveEnv("GEMINI_API_KEY");
        if (!apiKey) {
            console.error("GEMINI_API_KEY not found (env, .env.local, .env).");
            process.exit(1);
        }

        // ── extraction loop ──
        const results = [];
        for (const row of candidates) {
            const imagePath = path.join(IMAGES_DIR, row.fileName);
            if (!fs.existsSync(imagePath)) {
                console.warn(`  SKIP ${row.sourceExternalId}: image file not found at ${imagePath}`);
                continue;
            }
            process.stdout.write(`  ${row.sourceExternalId} (${row.kind}) ... `);
            let raw;
            try {
                raw = await extractViaGemini(apiKey, fs.readFileSync(imagePath), row.mime);
            } catch (err) {
                console.log(`FAILED: ${err.message}`);
                continue;
            }
            const scrubbed = scrubExtraction(raw, {
                checkNumber: row.normalizedCheckNumber,
                amountCents: row.amountCents,
            });
            for (const w of scrubbed.warnings) console.warn(`\n    WARNING ${row.sourceExternalId}: ${w}`);
            console.log(`payer="${scrubbed.payerName ?? ""}" memo="${scrubbed.memoText ?? ""}"` +
                (scrubbed.documentDate ? ` date=${scrubbed.documentDate}` : "") +
                (scrubbed.amount ? ` amt=${scrubbed.amount}` : "") +
                (scrubbed.checkNumber ? ` chk#${scrubbed.checkNumber}` : ""));

            // Cross-checks are advisory: log disagreement, store nothing extra.
            if (row.normalizedCheckNumber && scrubbed.checkNumber &&
                scrubbed.checkNumber.replace(/\D/g, "").replace(/^0+/, "") !== row.normalizedCheckNumber) {
                console.warn(`    NOTE: image check# ${scrubbed.checkNumber} != row check# ${row.normalizedCheckNumber}`);
            }

            results.push({ ...row, payerName: scrubbed.payerName, memoText: scrubbed.memoText, needsReview: scrubbed.needsReview });

            if (commit) {
                // needsReview rows store NULL for BOTH kept fields: a scrub
                // warning means the extraction is suspect (dropped digit run,
                // truncated overrun), so nothing from it is trusted. The row
                // is still stamped extractedAt/extractionModel so replay
                // skips it; a human re-reads the image instead.
                const storePayer = scrubbed.needsReview ? null : scrubbed.payerName;
                const storeMemo = scrubbed.needsReview ? null : scrubbed.memoText;
                if (scrubbed.needsReview) {
                    console.warn(`    NEEDS REVIEW ${row.sourceExternalId}: stored NULL payer/memo — a human must read this image (file: ${row.fileName})`);
                }
                await prisma.$executeRaw`
                    UPDATE "BankImage"
                    SET "payerName" = ${storePayer},
                        "memoText" = ${storeMemo},
                        "extractedAt" = now(),
                        "extractionModel" = ${GEMINI_MODEL},
                        "updatedAt" = now()
                    WHERE "id" = ${row.id} AND "extractedAt" IS NULL`;
            }
        }

        if (dryRun) console.log(`\nDRY RUN — nothing written. Re-run with --commit${columnsReady ? "" : " after applying the DDL"}.`);
        else console.log(`\nwrote ${results.length} extraction(s) [model ${GEMINI_MODEL}] (replay skips them)`);

        // ── review report ──
        if (prisma) {
            const clients = await prisma.$queryRawUnsafe(`SELECT "id", "name" FROM "Client"`);
            const projects = await prisma.$queryRawUnsafe(`SELECT "id", "name" FROM "Project"`);
            printReviewReport(results, clients, projects);
        } else {
            console.log("\n(no DATABASE_URL — skipping the review report's Client/Project matching)");
        }
    } finally {
        if (prisma) await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
