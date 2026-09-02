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
    hourlyRate: number;
};

export type RateImportParse = {
    rows: ParsedRateRow[];
    /** Rows that could not be read at all — surfaced, never silently dropped. */
    errors: string[];
};

export type RateDiffRow = {
    userId: string | null;
    name: string;
    email: string | null;
    oldHourly: number | null;
    newHourly: number;
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
    hourlyRate: number;
};

/** Highest rate the import will accept without a human overriding it by hand — a typo like "5500" instead of "55.00" must not reach payroll. */
export const MAX_IMPORTABLE_HOURLY_RATE = 500;

const HEADER_HINTS = {
    email: ["email"],
    name: ["employee name", "full name", "name"],
    firstName: ["first name", "first"],
    lastName: ["last name", "last"],
    rate: ["compensation rate", "hourly rate", "pay rate", "rate", "wage"],
};

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

/** "$28.50" / "28,50"-free money text -> number. Returns null when there is no number in it. */
export function parseRateValue(raw: string): number | null {
    const cleaned = raw.replace(/[$\s,]/g, "");
    if (!cleaned) return null;
    const value = Number(cleaned);
    if (!Number.isFinite(value)) return null;
    return value;
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

        const hourlyRate = parseRateValue(rateText);
        if (hourlyRate == null) {
            errors.push(`Row ${lineNumber} (${name || email}): could not read the rate "${rateText}".`);
            continue;
        }
        if (hourlyRate < 0) {
            errors.push(`Row ${lineNumber} (${name || email}): a negative rate is not a rate.`);
            continue;
        }
        if (hourlyRate > MAX_IMPORTABLE_HOURLY_RATE) {
            errors.push(
                `Row ${lineNumber} (${name || email}): ${hourlyRate} is over the $${MAX_IMPORTABLE_HOURLY_RATE}/h import limit — enter it by hand if it is real.`
            );
            continue;
        }

        rows.push({ lineNumber, name, email, hourlyRate });
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
export function diffRates(parsed: ParsedRateRow[], users: ImportableUser[]): RateDiffRow[] {
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

        if (user && claimed.has(user.id)) {
            // The same person twice in one file: take neither silently.
            return {
                userId: null,
                name: row.name,
                email: row.email,
                oldHourly: null,
                newHourly: row.hourlyRate,
                matched: false,
                matchedBy: null,
                changed: false,
                note: "This team member appears more than once in the file — fix the file and re-import.",
            };
        }
        if (user) claimed.add(user.id);

        return {
            userId: user?.id ?? null,
            name: user?.name ?? row.name,
            email: row.email ?? user?.email ?? null,
            oldHourly: user ? user.hourlyRate : null,
            newHourly: row.hourlyRate,
            matched: !!user,
            matchedBy,
            changed: !!user && Math.abs(user.hourlyRate - row.hourlyRate) > 1e-9,
            note,
        };
    });
}
