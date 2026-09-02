// Gusto employee-export -> ProBuild hourly rate import (Phase 5 spec G1).
//
// Pure: parsing and diffing only, no prisma and no session. The server actions
// in actions.ts (previewGustoRateImport / applyGustoRateImport) put a database
// and an auth gate around it, and the preview the human approves is computed by
// exactly this code.
//
// SCOPE — hourlyRate ONLY. Gusto's employee export has no concept of ProBuild's
// burdenRate (payroll tax + workers comp layered on wages for job costing), so
// the import must never touch it; burden stays hand-maintained on the team
// member editor. Spec section 7 risk 4.
//
// COLUMN NAMES ARE AN ASSUMPTION (spec section 7 risk 1) — the exact Gusto CSV
// header is unverified until the parallel run. Matching is therefore fuzzy and
// header-order independent: any column whose name contains "email" is the
// email, any "rate"/"salary"-ish column is the rate, and either a single name
// column or a first/last pair supplies the name. Widen HEADER_HINTS when the
// real file shows up rather than rewriting the parser.

export type ParsedRateRow = {
    /** 1-based row number in the source file, for error messages a human can act on. */
    lineNumber: number;
    name: string;
    email: string | null;
    /**
     * CANONICAL DECIMAL TEXT, never a JS number. A pay rate is money: 28.005
     * has no exact binary float, and Number("1e2") silently becomes 100. The
     * text is carried all the way to `new Prisma.Decimal(text)` at write time so
     * nothing is ever rounded on the way through.
     */
    /**
     * Canonical decimal TEXT, or null for a SALARY row.
     *
     * A salaried person's "compensation rate" in Gusto is an ANNUAL figure —
     * 92,000, not 44.23. Reading it as an hourly rate is nonsense, and because
     * it also fails the plausibility ceiling it used to produce a parse error
     * that (correctly) blocked the whole import. Their pay type is the useful
     * part of the row; the rate is not ours to guess.
     */
    hourlyRate: string | null;
    /** "HOURLY" | "SALARY" when the file said so, else null. */
    payType: string | null;
};

export type RateImportParse = {
    rows: ParsedRateRow[];
    /** Rows that could not be read at all — surfaced, never silently dropped. */
    errors: string[];
};

export type RateDiffRow = {
    userId: string | null;
    /** Per-ROW token: the fingerprint SIGNED by the server (see rowFingerprint). Only set on a matched row. */
    rowHash: string | null;
    /** The member's pay type when the preview was built — part of what is being approved. */
    oldPayType: string | null;
    name: string;
    email: string | null;
    /** Canonical decimal TEXT (2 places), or null when nothing matched. */
    oldHourly: string | null;
    /** Canonical decimal TEXT (2 places), or null when the row only sets a pay type. */
    newHourly: string | null;
    /** Pay type the file supplied for this row, if any. */
    payType: string | null;
    matched: boolean;
    matchedBy: "email" | "name" | null;
    changed: boolean;
    /** Why an unmatched row did not match, or why a matched one is unusual. */
    note: string | null;
};

export type ImportableUser = {
    id: string;
    name: string | null;
    email: string;
    /** Canonical decimal text of the CURRENT stored rate. */
    hourlyRate: string;
    status?: string | null;
    payType?: string | null;
};

/** Highest rate the import will accept without a human overriding it by hand — a typo like "5500" instead of "55.00" must not reach payroll. */
export const MAX_IMPORTABLE_HOURLY_RATE = 500;

const HEADER_HINTS = {
    email: ["email"],
    name: ["employee name", "full name", "name"],
    firstName: ["first name", "first"],
    lastName: ["last name", "last"],
    rate: ["compensation rate", "hourly rate", "pay rate", "rate", "wage"],
    payType: ["compensation type", "pay type", "employee type", "pay basis"],
};

/** Gusto spells the compensation type a few ways; anything else is left as "not stated". */
export function normalizePayType(raw: string): string | null {
    const value = raw.trim().toLowerCase();
    if (!value) return null;
    if (value.includes("salar")) return "SALARY";
    if (value.includes("hour")) return "HOURLY";
    return null;
}

/** RFC4180-ish reader: quoted fields, doubled quotes inside them, CR/LF or LF line endings. */
export function parseCsvGrid(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let sawAnyChar = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
            continue;
        }
        if (char === '"') {
            inQuotes = true;
            sawAnyChar = true;
            continue;
        }
        if (char === ",") {
            row.push(field);
            field = "";
            sawAnyChar = true;
            continue;
        }
        if (char === "\r") continue;
        if (char === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
            sawAnyChar = false;
            continue;
        }
        field += char;
        sawAnyChar = true;
    }
    if (field.length > 0 || sawAnyChar || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function findColumn(headers: string[], hints: string[]): number {
    // Hints are ordered most-specific first so "compensation rate" wins over a
    // bare "rate" column when a file has both.
    for (const hint of hints) {
        const index = headers.findIndex((header) => header === hint);
        if (index >= 0) return index;
    }
    for (const hint of hints) {
        const index = headers.findIndex((header) => header.includes(hint));
        if (index >= 0) return index;
    }
    return -1;
}

/**
 * Money text in, CANONICAL DECIMAL TEXT out ("28.5" -> "28.50"), or null.
 *
 * Deliberately strict, because every loose reading of this field is a wrong
 * paycheque:
 *  - a COMMA is refused, not stripped: stripping turns the European "28,50"
 *    into 2850, a 100x rate, and "1,200" is not a plausible hourly rate anyway;
 *  - EXPONENT notation is refused: Number("1e2") is 100, which is not what
 *    anybody typed into a payroll system;
 *  - more than 2 fractional digits is refused rather than rounded. 28.005 is
 *    not a rate somebody meant, and silently making it 28.01 (or 28.00) is the
 *    kind of half-cent decision a human should make, not an importer.
 *
 * The result is text, never a float — the caller hands it to Prisma.Decimal.
 */
export function parseRateValue(raw: string): string | null {
    if (raw.includes(",")) return null;
    const cleaned = raw.replace(/[$\s]/g, "");
    if (!cleaned) return null;
    // Optional sign, digits, optional . and up to 2 digits. No exponent, no hex,
    // no "Infinity" — all of which Number() would happily accept.
    const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
    if (!match) return null;
    const [, sign, whole, fraction = ""] = match;
    if (sign === "-") return "-" + whole + "." + fraction.padEnd(2, "0");
    return whole + "." + fraction.padEnd(2, "0");
}

/** Canonical 2-place text for a value that is already known to be a valid number-ish string. */
export function canonicalRateText(value: string | number): string {
    const parsed = parseRateValue(String(value));
    return parsed ?? "0.00";
}

export function parseGustoRateCsv(text: string): RateImportParse {
    const grid = parseCsvGrid(text ?? "");
    if (grid.length === 0) return { rows: [], errors: ["The file is empty."] };

    const headers = grid[0].map((cell) => cell.trim().toLowerCase());
    const emailAt = findColumn(headers, HEADER_HINTS.email);
    const nameAt = findColumn(headers, HEADER_HINTS.name);
    const firstAt = findColumn(headers, HEADER_HINTS.firstName);
    const lastAt = findColumn(headers, HEADER_HINTS.lastName);
    const rateAt = findColumn(headers, HEADER_HINTS.rate);
    const payTypeAt = findColumn(headers, HEADER_HINTS.payType);

    const errors: string[] = [];
    if (rateAt < 0) {
        return {
            rows: [],
            errors: ['No rate column found. Expected a column named something like "Compensation rate".'],
        };
    }
    if (emailAt < 0 && nameAt < 0 && (firstAt < 0 || lastAt < 0)) {
        return {
            rows: [],
            errors: ["No email or name column found — there is no way to tell which team member a row belongs to."],
        };
    }

    const rows: ParsedRateRow[] = [];
    for (let i = 1; i < grid.length; i += 1) {
        const cells = grid[i];
        const lineNumber = i + 1;
        const at = (index: number) => (index >= 0 ? (cells[index] ?? "").trim() : "");

        const single = at(nameAt);
        const combined = [at(firstAt), at(lastAt)].filter(Boolean).join(" ");
        // A first/last pair beats a single "name" column: Gusto's export carries
        // both, and the single column is sometimes a preferred/display name.
        const name = (firstAt >= 0 && lastAt >= 0 && combined ? combined : single).replace(/\s+/g, " ").trim();
        const email = at(emailAt).toLowerCase() || null;
        const rateText = at(rateAt);

        if (!name && !email) continue; // blank row

        // Pay type FIRST: it decides whether the rate column means anything.
        const payType = normalizePayType(at(payTypeAt));
        if (payType === "SALARY") {
            // Pay type only. Never an hourlyRate — see ParsedRateRow.hourlyRate.
            rows.push({ lineNumber, name, email, hourlyRate: null, payType });
            continue;
        }

        const hourlyRate = parseRateValue(rateText);
        if (hourlyRate == null) {
            errors.push(
                `Row ${lineNumber} (${name || email}): could not read the rate "${rateText}". Use plain digits with at most two decimal places, e.g. 28.50.`
            );
            continue;
        }
        if (hourlyRate.startsWith("-")) {
            errors.push(`Row ${lineNumber} (${name || email}): a negative rate is not a rate.`);
            continue;
        }
        // Compared as a NUMBER only for the sanity ceiling; the value that gets
        // written is always the text.
        if (Number(hourlyRate) > MAX_IMPORTABLE_HOURLY_RATE) {
            errors.push(
                `Row ${lineNumber} (${name || email}): ${hourlyRate} is over the $${MAX_IMPORTABLE_HOURLY_RATE}/h import limit — enter it by hand if it is real.`
            );
            continue;
        }

        rows.push({ lineNumber, name, email, hourlyRate, payType });
    }

    return { rows, errors };
}

function normalizeName(value: string | null | undefined): string {
    return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Match each parsed row to a ProBuild user — EMAIL FIRST, exact full name only
 * as a fallback, and never a fuzzy name match: writing a pay rate onto the
 * wrong person is worse than leaving a row unmatched for a human to sort out.
 * An ambiguous name (two members share it) is deliberately left unmatched.
 */
export function diffRates(
    parsed: ParsedRateRow[],
    users: ImportableUser[],
    /** Signer for each matched row. Defaults to the unsigned fingerprint so pure tests stay pure. */
    signRow: (input: RowFingerprintInput) => string = rowFingerprint
): RateDiffRow[] {
    const byEmail = new Map<string, ImportableUser>();
    for (const user of users) byEmail.set(user.email.trim().toLowerCase(), user);

    const byName = new Map<string, ImportableUser[]>();
    for (const user of users) {
        const key = normalizeName(user.name);
        if (!key) continue;
        const bucket = byName.get(key);
        if (bucket) bucket.push(user);
        else byName.set(key, [user]);
    }

    const claimed = new Set<string>();
    return parsed.map((row) => {
        let user: ImportableUser | undefined;
        let matchedBy: "email" | "name" | null = null;
        let note: string | null = null;

        if (row.email) {
            user = byEmail.get(row.email);
            if (user) matchedBy = "email";
        }
        if (!user) {
            const candidates = byName.get(normalizeName(row.name)) ?? [];
            if (candidates.length === 1) {
                user = candidates[0];
                matchedBy = "name";
                note = "Matched by name — no email in the file matched a team member.";
            } else if (candidates.length > 1) {
                note = "Two team members share this name — set the rate by hand.";
            } else {
                note = "No team member with this email or name.";
            }
        }

        if (user && user.status === "DISABLED") {
            // A disabled account is off payroll. Writing a rate to it is
            // pointless at best and, if it is ever re-enabled, a stale rate
            // nobody reviewed.
            return {
                userId: null,
                rowHash: null,
                oldPayType: null,
                name: user.name ?? row.name,
                email: user.email,
                oldHourly: null,
                newHourly: row.hourlyRate,
                payType: row.payType,
                matched: false,
                matchedBy: null,
                changed: false,
                note: "That account is disabled — re-activate it first if this rate should apply.",
            };
        }

        if (user && claimed.has(user.id)) {
            // The same person twice in one file: take neither silently.
            return {
                userId: null,
                rowHash: null,
                oldPayType: null,
                name: row.name,
                email: row.email,
                oldHourly: null,
                newHourly: row.hourlyRate,
                payType: row.payType,
                matched: false,
                matchedBy: null,
                changed: false,
                note: "This team member appears more than once in the file — fix the file and re-import.",
            };
        }
        if (user) claimed.add(user.id);

        const oldHourly = user ? canonicalRateText(user.hourlyRate) : null;
        const oldPayType = user ? user.payType ?? null : null;
        return {
            userId: user?.id ?? null,
            oldPayType,
            rowHash: user
                ? signRow({
                      userId: user.id,
                      oldHourly,
                      oldPayType,
                      newHourly: row.hourlyRate,
                      payType: row.payType,
                  })
                : null,
            name: user?.name ?? row.name,
            // The MATCHED member's email wins. Showing the CSV's address for a
            // NAME match is how a human approves a write to the wrong person:
            // the row would display an email that belongs to nobody in
            // ProBuild while the rate lands on whoever shares the name.
            email: user ? user.email : row.email,
            oldHourly,
            newHourly: row.hourlyRate,
            payType: row.payType,
            matched: !!user,
            matchedBy,
            // Canonical TEXT comparison — exact, and free of the float epsilon
            // fudge the numeric version needed.
            changed:
                !!user &&
                ((row.hourlyRate != null && canonicalRateText(user.hourlyRate) !== row.hourlyRate) ||
                    (!!row.payType && row.payType !== (user.payType ?? null))),
            note,
        };
    });
}

/**
 * Fingerprint of exactly what a human approved: each row's target user, the
 * rate and pay type to be written, AND the user's rate/pay type AT PREVIEW
 * TIME.
 *
 * Apply re-computes this from the live database and refuses if it differs. That
 * is what makes the two-step import honest: without it, `apply` is just an
 * arbitrary "set these people's pay rates" endpoint that trusts a body the
 * browser could replay minutes later, against rates somebody else has since
 * changed. Including the OLD values is the point — a stale approval is a
 * different decision from the one that was shown.
 */
export function previewFingerprint(rows: RateDiffRow[]): string {
    return rows
        .filter((row) => row.userId)
        .map((row) => row.rowHash ?? "")
        .sort()
        .join("|");
}

/**
 * PER-ROW fingerprint: the target user, the rate they had when the preview was
 * built, and the rate/pay type about to be written.
 *
 * Per row rather than per file, because a human can tick a SUBSET of the
 * preview. A whole-file hash forces an all-or-nothing save: tick three of ten
 * rows and the recomputed hash never matches, so a legitimate partial import is
 * rejected. Each submitted row now carries its own hash and is validated on its
 * own, and the DB write is additionally guarded on the previewed old rate.
 */
export type RowFingerprintInput = {
    userId: string;
    /** The member's rate when the preview was built. */
    oldHourly: string | null;
    /** The member's pay type when the preview was built. */
    oldPayType: string | null;
    /** The rate about to be written, or null for a pay-type-only row. */
    newHourly: string | null;
    /** The pay type about to be written (null = leave it alone). */
    payType: string | null;
};

/**
 * The claim being made by one previewed row. BOTH old values are included: a
 * concurrent null -> SALARY correction has to invalidate a preview that still
 * thinks the member is HOURLY, or the stale preview silently reverts it.
 *
 * This is the payload only. It is not evidence on its own — `signRowToken`
 * turns it into something the server can verify, because plain concatenation is
 * trivially reproducible by any caller and would let a client fabricate an
 * "approved" update it was never shown.
 */
export function rowFingerprint(input: RowFingerprintInput): string {
    return [
        input.userId,
        input.oldHourly ?? "",
        input.oldPayType ?? "",
        input.newHourly ?? "",
        input.payType ?? "",
    ].join(":");
}

/**
 * True when any ProBuild member is claimed by more than one row of the file.
 *
 * The whole PREVIEW is rejected in that case, not just the duplicate rows: if a
 * file lists somebody twice with different rates, nobody can say which one the
 * office meant, and importing the other nine people while silently dropping the
 * ambiguous one leaves a half-applied payroll change nobody reviewed.
 */
export function hasDuplicateTargets(parsed: ParsedRateRow[], users: ImportableUser[]): boolean {
    const rows = diffRates(parsed, users);
    return rows.some((row) => (row.note ?? "").includes("more than once"));
}
