/**
 * Read-only conflict INVENTORY for the QBO_REGISTER observations on WTB-0723.
 *
 * One fresh (never cached) GL fetch over the planner's rolling 60-day window,
 * one bounded read of stored QBO_REGISTER observations, and a pure comparison
 * through the same `registerRowToIngestLine` the nightly pull uses. Every
 * disagreement is classified and the differing fields are surfaced with
 * stored/fresh values. Nothing is written, no QBO entity is read, no repair is
 * performed and no row is ever called eligible or safe.
 *
 * FAIL CLOSED: a stale fetch, a failed clearance probe or either row cap
 * overflowing yields `status: "unavailable"` with null counts, never a partial
 * inventory that reads as complete.
 */
import { BANK_REGISTER_ACCOUNT, registerRowToIngestLine, type BankRegisterIngestLine, type BankRegisterRowLike } from "@/lib/bank-register-pull";

export const INVENTORY_SOURCE = "QBO_REGISTER";
export const MAX_STORED_ROWS = 2000;
export const MAX_GL_ROWS = 2000;
/** Exact qbType values the inventory treats as supported. Everything else is surfaced. */
export const SUPPORTED_QB_TYPES: ReadonlySet<string> = new Set(["Expense", "Deposit"]);

export interface DateWindow { startDate: string; endDate: string }

export interface StoredInventoryRow {
    id: string;
    sourceLineId: string | null;
    postedDate: Date | string;
    rawDescriptor: string | null;
    amountCents: number;
    checkNumber: string | null;
    bankLineId: string | null;
}

export const STORED_INVENTORY_SELECT = {
    id: true, sourceLineId: true, postedDate: true, rawDescriptor: true, amountCents: true, checkNumber: true, bankLineId: true,
} as const;

export interface StoredInventoryClient {
    bankLineObservation: {
        findMany(input: {
            where: {
                source: string; account: string; sourceDocumentId: string;
                OR: [{ postedDate: { gte: Date; lte: Date } }, { sourceLineId: { in: string[] } }];
            };
            select: typeof STORED_INVENTORY_SELECT;
            take: number;
        }): Promise<StoredInventoryRow[]>;
    };
}

/** Fresh GL identities, deduplicated. Only these may pull a stored row from outside the window. */
export function freshGlIds(rows: readonly BankRegisterRowLike[]): string[] {
    return [...new Set(rows.map(row => row.qbTxnId).filter((id): id is string => !!id))];
}

/** Prisma adapter. Scope is fixed here: source, account, document, projection, cap + 1 sentinel. */
export function createStoredInventoryReader(client: StoredInventoryClient) {
    return async (window: DateWindow, sourceLineIds: string[]): Promise<StoredInventoryRow[]> =>
        client.bankLineObservation.findMany({
            where: {
                source: INVENTORY_SOURCE, account: BANK_REGISTER_ACCOUNT, sourceDocumentId: INVENTORY_SOURCE,
                OR: [
                    { postedDate: { gte: new Date(`${window.startDate}T00:00:00Z`), lte: new Date(`${window.endDate}T00:00:00Z`) } },
                    { sourceLineId: { in: sourceLineIds } },
                ],
            },
            select: STORED_INVENTORY_SELECT,
            take: MAX_STORED_ROWS + 1,
        });
}

export interface RegisterSnapshot {
    rows: readonly BankRegisterRowLike[];
    stale: boolean;
    clearedProbeOk?: boolean;
    fetchedAt?: unknown;
    startDate: string;
    endDate: string;
}

export type UnavailableReason = "stale-register" | "incomplete-source" | "gl-overflow" | "stored-overflow";

export function registerUnavailableReason(register: RegisterSnapshot): UnavailableReason | null {
    if (register.stale) return "stale-register";
    if (register.clearedProbeOk !== true) return "incomplete-source";
    if (register.rows.length > MAX_GL_ROWS) return "gl-overflow";
    return null;
}

export type DiffField = "postedDate" | "amountCents" | "rawDescriptor" | "checkNumber";
export interface FieldDiff { field: DiffField; stored: string | number | null; fresh: string | number | null }

function ymd(value: Date | string): string {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function isoOrNull(value: unknown): string | null {
    if (value instanceof Date) return value.toISOString();
    return typeof value === "string" ? value : null;
}

/** Exact field-by-field comparison of a stored row against the fresh ingest line. PURE. */
export function diffStoredAgainstFresh(stored: StoredInventoryRow, fresh: BankRegisterIngestLine): FieldDiff[] {
    const diffs: FieldDiff[] = [];
    const storedDate = ymd(stored.postedDate);
    if (storedDate !== fresh.postedDate) diffs.push({ field: "postedDate", stored: storedDate, fresh: fresh.postedDate });
    if (stored.amountCents !== fresh.amountCents) diffs.push({ field: "amountCents", stored: stored.amountCents, fresh: fresh.amountCents });
    if ((stored.rawDescriptor ?? null) !== fresh.rawDescriptor) diffs.push({ field: "rawDescriptor", stored: stored.rawDescriptor ?? null, fresh: fresh.rawDescriptor });
    if ((stored.checkNumber ?? null) !== fresh.checkNumber) diffs.push({ field: "checkNumber", stored: stored.checkNumber ?? null, fresh: fresh.checkNumber });
    return diffs;
}

const byId = <T extends { qbTxnId: string }>(a: T, b: T) => a.qbTxnId.localeCompare(b.qbTxnId);

/** Build the whole inventory body. PURE; `stored` is the capped read (cap + 1 sentinel). */
export function buildConflictInventory(register: RegisterSnapshot, stored: readonly StoredInventoryRow[]) {
    const common = {
        ok: true, account: BANK_REGISTER_ACCOUNT, source: INVENTORY_SOURCE,
        window: { startDate: register.startDate, endDate: register.endDate },
        fetchedAt: isoOrNull(register.fetchedAt), clearedProbeOk: register.clearedProbeOk === true,
        scope: { sourceDocumentId: INVENTORY_SOURCE, storedFilter: "postedDate in window OR sourceLineId in fresh GL ids", registerScope: "parsed GL rows in the requested window, not complete bank eligibility", storedRowCap: MAX_STORED_ROWS, glRowCap: MAX_GL_ROWS },
        note: "Read-only inventory. No repair performed. No row is asserted eligible or safe; unsupported types are surfaced, not judged.",
    };
    const reason = registerUnavailableReason(register) ?? (stored.length > MAX_STORED_ROWS ? "stored-overflow" : null);
    if (reason) return { ...common, ok: false, status: "unavailable" as const, reason, counts: null };

    const glById = new Map<string, BankRegisterRowLike[]>();
    let missingIdentity = 0;
    const missingIdentityRows: {rowIndex:number; qbType:string; date:string; amountCents:number}[] = [];
    for (const [rowIndex, row] of register.rows.entries()) {
        if (!row.qbTxnId) { missingIdentity++; missingIdentityRows.push({rowIndex, qbType:row.qbType, date:row.date, amountCents:row.amountCents}); continue; }
        const group = glById.get(row.qbTxnId);
        if (group) group.push(row); else glById.set(row.qbTxnId, [row]);
    }
    const storedById = new Map<string, StoredInventoryRow[]>();
    for (const row of stored) {
        if (!row.sourceLineId) continue;
        const group = storedById.get(row.sourceLineId);
        if (group) group.push(row); else storedById.set(row.sourceLineId, [row]);
    }

    const duplicateGlIds: { qbTxnId: string; count: number; qbTypes: string[] }[] = [];
    const unconvertible: { qbTxnId: string; qbType: string; date: string; amountCents: number }[] = [];
    const missingStored: { qbTxnId: string; qbType: string; supportedType: boolean; postedDate: string; amountCents: number; rawDescriptor: string; checkNumber: string | null }[] = [];
    const duplicateStoredIds: { qbTxnId: string; storedIds: string[] }[] = [];
    type Changed = { qbTxnId: string; qbType: string; supportedType: boolean; storedId: string; bankLineId: string | null; linked: boolean; diffs: FieldDiff[] };
    const changed: Changed[] = [];
    const changedLinked: Changed[] = [];
    const unsupportedUnchanged: Omit<Changed, "diffs">[] = [];
    let unchanged = 0;

    for (const [qbTxnId, group] of glById) {
        if (group.length > 1) { duplicateGlIds.push({ qbTxnId, count: group.length, qbTypes: group.map(r => r.qbType) }); continue; }
        const row = group[0];
        const supportedType = SUPPORTED_QB_TYPES.has(row.qbType);
        const line = registerRowToIngestLine(row);
        if (!line) { unconvertible.push({ qbTxnId, qbType: row.qbType, date: row.date, amountCents: row.amountCents }); continue; }
        const matches = storedById.get(qbTxnId) ?? [];
        if (matches.length === 0) {
            missingStored.push({ qbTxnId, qbType: row.qbType, supportedType, postedDate: line.postedDate, amountCents: line.amountCents, rawDescriptor: line.rawDescriptor, checkNumber: line.checkNumber });
            continue;
        }
        if (matches.length > 1) { duplicateStoredIds.push({ qbTxnId, storedIds: matches.map(m => m.id).sort() }); continue; }
        const s = matches[0];
        const base = { qbTxnId, qbType: row.qbType, supportedType, storedId: s.id, bankLineId: s.bankLineId ?? null, linked: s.bankLineId != null };
        const diffs = diffStoredAgainstFresh(s, line);
        if (diffs.length === 0) { unchanged++; if (!supportedType) unsupportedUnchanged.push(base); continue; }
        (base.linked ? changedLinked : changed).push({ ...base, diffs });
    }

    const sourceMissing = stored
        .filter(s => (!s.sourceLineId || !glById.has(s.sourceLineId)) && ymd(s.postedDate) >= register.startDate && ymd(s.postedDate) <= register.endDate)
        .map(s => ({ storedId: s.id, sourceLineId: s.sourceLineId ?? null, postedDate: ymd(s.postedDate), amountCents: s.amountCents, rawDescriptor: s.rawDescriptor ?? null, checkNumber: s.checkNumber ?? null, bankLineId: s.bankLineId ?? null, linked: s.bankLineId != null }))
        .sort((a, b) => a.storedId.localeCompare(b.storedId));

    const lists = {
        duplicateGlIds: duplicateGlIds.sort(byId), unconvertible: unconvertible.sort(byId), missingStored: missingStored.sort(byId),
        duplicateStoredIds: duplicateStoredIds.sort(byId), changed: changed.sort(byId), changedLinked: changedLinked.sort(byId),
        unsupportedUnchanged: unsupportedUnchanged.sort(byId), sourceMissing,
    };
    return {
        ...common, status: "ok" as const,
        counts: {
            glRows: register.rows.length, storedRows: stored.length, missingIdentity, unchanged,
            duplicateGlIds: lists.duplicateGlIds.length, unconvertible: lists.unconvertible.length, missingStored: lists.missingStored.length,
            duplicateStoredIds: lists.duplicateStoredIds.length, changed: lists.changed.length, changedLinked: lists.changedLinked.length,
            unsupportedUnchanged: lists.unsupportedUnchanged.length, sourceMissing: lists.sourceMissing.length,
        },
        missingIdentityRows, ...lists,
    };
}

export interface ConflictInventoryDependencies {
    authorize(request: Request): boolean;
    window(now: Date): DateWindow;
    readRegister(window: DateWindow): Promise<RegisterSnapshot>;
    readStored(window: DateWindow, sourceLineIds: string[]): Promise<StoredInventoryRow[]>;
    now?(): Date;
}

function jsonNoStore(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function createConflictInventoryHandlers(deps: ConflictInventoryDependencies) {
    async function GET(request: Request): Promise<Response> {
        if (!deps.authorize(request)) return jsonNoStore({ ok: false, reason: "unauthorized" }, 401);
        if (Array.from(new URL(request.url).searchParams.entries()).length > 0) return jsonNoStore({ ok: false, reason: "invalid-query" }, 400);
        const window = deps.window(deps.now ? deps.now() : new Date());
        try {
            const register = await deps.readRegister(window);
            if (registerUnavailableReason(register)) return jsonNoStore(buildConflictInventory(register, []), 200);
            const stored = await deps.readStored(window, freshGlIds(register.rows));
            return jsonNoStore(buildConflictInventory(register, stored), 200);
        } catch (error) {
            console.error("conflict inventory upstream failed", error instanceof Error ? error.name : "UnknownError");
            return jsonNoStore({ ok: false, status: "unavailable", reason: "upstream-unavailable", counts: null }, 503);
        }
    }
    return { GET };
}
