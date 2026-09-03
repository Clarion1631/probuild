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
    /**
     * ISO text of User.lastRateSyncAt, or null if a rate was never imported.
     *
     * Display only now — "last CONFIRMED", shown on the rates panel. It does
     * NOT move on a pay-type-only write (round-32 gate), so it can no longer
     * be trusted to detect an A -> B -> A replay on its own; payrollRevision
     * below is what the signature is actually keyed on.
     */
    lastRateSyncAt?: string | null;
    /**
     * Monotonic counter, bumped on EVERY payroll-affecting write to this user
     * (a rate confirmation OR a pay-type-only change) — see
     * User.payrollRevision in prisma/schema.prisma.
     *
     * Part of the row's identity, not decoration: it is what makes an A -> B -> A
     * replay detectable. Rate and pay type both return to their old values when
     * somebody sets them back by hand, so an old preview's token would verify
     * again and silently re-apply a decision nobody made twice, if the
     * fingerprint were keyed on the values alone. This counter only moves
     * forward, unlike lastRateSyncAt, which a pay-type-only write leaves
     * untouched.
     *
     * Optional here (test fixtures predate this field) — treated as 0 when
     * absent, matching the column's own default for a row nothing has ever
     * touched.
     */
    payrollRevision?: number;
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

export class CsvParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CsvParseError";
    }
}

/**
 * RFC4180 reader: quoted fields, doubled quotes inside them, CR/LF or LF.
 *
 * Strict on purpose. The lenient version silently produced a grid that LOOKED
 * fine from a file that was not:
 *
 *  - an unterminated quote swallowed the rest of the file into one field, so a
 *    hundred-row import became one row and the other ninety-nine vanished with
 *    no error at all;
 *  - a stray quote mid-field, and a ragged row with the wrong number of
 *    columns, both shifted every later value one column left — which for this
 *    file means somebody's NAME lands in the rate column, or one person's rate
 *    lands on another person's row.
 *
 *  - a BARE CARRIAGE RETURN was dropped, wherever it appeared. Outside a
 *    quoted field every `\r` was skipped on the assumption it was the first
 *    half of a CRLF, so `2\r8` — a mangled export, a half-converted line
 *    ending, a value pasted out of a terminal — silently became the rate
 *    28.00. This is the same class of bug as the `$`/space scrubbing below:
 *    the parser repaired malformed money into a plausible number instead of
 *    refusing it. A `\r` is now accepted ONLY as the first half of `\r\n`;
 *    anywhere else it is a parse error. Inside QUOTES it stays verbatim, like
 *    every other character there — the quotes say where the field ends, so
 *    there is nothing to guess, and a stray CR in the rate column is refused
 *    by parseRateValue anyway;
 *
 *  - characters AFTER a closing quote were appended to the value as if the
 *    quotes had never been there: `"Alex Smith"x` read as `Alex Smithx`, and
 *    `"28.50"0` as a rate of 28.500. Neither is what the file says, and both
 *    come from exactly the kind of half-escaped export this parser exists to
 *    refuse. TRAILING SPACES ARE REFUSED TOO (`"Alex Smith" ,`): there is no
 *    honest reading of them — either the space is part of the name, in which
 *    case it belonged inside the quotes, or the file was written by something
 *    that does not agree with this one about where a field ends, and the next
 *    surprise it holds may not be one this parser notices.
 *
 * A pay-rate file that cannot be read exactly is not a file to guess at.
 */
export function parseCsvGrid(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let fieldWasQuoted = false;
    /** A quoted field has ENDED; only a delimiter, a line ending or EOF may follow. */
    let closedQuote = false;
    let sawAnyChar = false;
    let line = 1;

    const pushField = () => {
        row.push(field);
        field = "";
        fieldWasQuoted = false;
        closedQuote = false;
    };

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                    closedQuote = true;
                }
            } else {
                if (char === "\n") line += 1;
                field += char;
            }
            continue;
        }
        // Between the closing quote and the end of the field, NOTHING is
        // allowed through. `\r` is let past ONLY so the CRLF branch below can
        // judge it: a `\r` that is not followed by `\n` throws there.
        if (closedQuote && char !== "," && char !== "\r" && char !== "\n") {
            throw new CsvParseError(
                `Line ${line}, column ${row.length + 1}: "${char}" appears after a closing quote. ` +
                    `A quoted value must be followed by a comma, the end of the line, or the end of the file — trailing spaces included.`
            );
        }
        if (char === '"') {
            // A quote may only OPEN a field. Mid-field it is a malformed row,
            // and guessing at what was meant is how a rate lands on the wrong
            // person.
            if (field.length > 0 || fieldWasQuoted) {
                throw new CsvParseError(`Line ${line}: unexpected quote in the middle of a field.`);
            }
            inQuotes = true;
            fieldWasQuoted = true;
            sawAnyChar = true;
            continue;
        }
        if (char === ",") {
            pushField();
            sawAnyChar = true;
            continue;
        }
        if (char === "\r") {
            // ONLY as the first half of CRLF. This used to be an unconditional
            // `continue`, which DELETED the character: `2\r8` came out as the
            // rate 28.00. A pay-rate file that cannot be read exactly is not a
            // file to guess at, and a lone CR is exactly the half-converted
            // export this parser exists to refuse.
            if (text[i + 1] !== "\n") {
                throw new CsvParseError(
                    `Line ${line}, column ${row.length + 1}: a stray carriage return that is not part of a line ending. ` +
                        `Save the file with normal line endings — a carriage return inside a value would silently change it.`
                );
            }
            continue;
        }
        if (char === "\n") {
            pushField();
            rows.push(row);
            row = [];
            sawAnyChar = false;
            line += 1;
            continue;
        }
        field += char;
        sawAnyChar = true;
    }

    if (inQuotes) {
        throw new CsvParseError("The file ends inside a quoted value — a quote is unclosed.");
    }
    if (field.length > 0 || sawAnyChar || row.length > 0) {
        pushField();
        rows.push(row);
    }

    const populated = rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
    if (populated.length > 1) {
        const width = populated[0].length;
        for (let i = 1; i < populated.length; i += 1) {
            if (populated[i].length !== width) {
                throw new CsvParseError(
                    `Row ${i + 1} has ${populated[i].length} columns but the header has ${width}. ` +
                        `A ragged row shifts every value after it into the wrong column.`
                );
            }
        }
    }
    return populated;
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
 * WHAT IS STRIPPED, AND WHAT IS NOT. This used to delete EVERY `$` and every
 * space anywhere in the string before matching, which quietly repaired
 * malformed money into a plausible number instead of refusing it: `2$8` became
 * 28.00 and `2 8.50` became 28.50 — a rate nobody typed, on somebody's
 * paycheque, with no error to look at. Now only SURROUNDING whitespace is
 * trimmed and only ONE LEADING `$` is accepted; a `$` or a space anywhere else
 * is a malformed value and is refused like any other.
 *
 * THOUSANDS SEPARATORS STAY REFUSED, deliberately: the comma rule above cannot
 * tell "1,234.56" apart from the European "28,50" without guessing at the
 * file's locale, and guessing wrong is a 100x rate. Nothing under the
 * $500/h import ceiling needs one anyway.
 *
 * The result is text, never a float — the caller hands it to Prisma.Decimal.
 */
export function parseRateValue(raw: string): string | null {
    if (raw.includes(",")) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Optional sign, ONE optional leading $, digits, optional . and up to 2
    // digits. No exponent, no hex, no "Infinity" — all of which Number() would
    // happily accept — and no internal $ or whitespace.
    const match = /^([+-]?)\$?(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
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
    let grid: string[][];
    try {
        grid = parseCsvGrid(text ?? "");
    } catch (error) {
        // Surfaced like any other unreadable-row error, so the preview refuses
        // and Save stays disabled rather than importing a misread file.
        return { rows: [], errors: [error instanceof Error ? error.message : "That file could not be read."] };
    }
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

        // A row is SKIPPED only when it is genuinely EMPTY. It used to be skipped
        // whenever it carried no name and no email, which silently discarded a
        // POPULATED row: `,,28.50,HOURLY` — a real rate, for nobody — vanished
        // from the preview while every other row in the file still applied. An
        // importer that quietly drops data is not strict, whatever the rest of
        // this parser does: the human never saw the row, so they never went and
        // fixed the one line that was wrong.
        //
        // parseCsvGrid already removes all-blank rows, so this test is normally
        // vacuous; it stays because it is the rule being stated, and the rule is
        // what a later change to the grid reader has to keep.
        const isBlankRow = cells.every((cell) => (cell ?? "").trim() === "");
        if (isBlankRow) continue;
        if (!name && !email) {
            // An ERROR, not a skip — and errors block the apply
            // (applyGustoRateImport refuses a file with any of them), so no
            // half-applied import can come out of a file with a row like this.
            errors.push(
                `Row ${lineNumber}: no name or email, so there is no way to tell which team member this row belongs to. ` +
                    `Fill one in, or delete the row.`
            );
            continue;
        }

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
    signRow: (input: RowFingerprintInput) => string = rowFingerprint,
    /**
     * sha256 of the file this diff was built from, bound into every row token.
     * Apply re-hashes the CSV it is given, so a token cannot be lifted out of
     * one preview and posted alongside a different file.
     */
    csvHash: string = ""
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
                      oldPayrollRevision: user.payrollRevision ?? 0,
                      csvHash,
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
    /**
     * The member's payrollRevision when the preview was built.
     *
     * The replay guard — NOT lastRateSyncAt, which is display-only now and
     * does not move on a pay-type-only write (round-32 gate). This counter
     * bumps on every payroll-affecting write regardless of which fields it
     * touches, so it is what actually invalidates a stale approval.
     */
    oldPayrollRevision: number;
    /** sha256 of the CSV this preview was built from. Binds the row to one file. */
    csvHash: string;
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
        String(input.oldPayrollRevision),
        input.csvHash,
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
