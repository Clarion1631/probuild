import { createHash } from "node:crypto";

export type ClockInIdentity = { requestId: string; requestHash: string } | null;
export class ClockInConflict extends Error {
    constructor(public code: "ALREADY_CLOCKED_IN" | "REQUEST_ID_CONFLICT" | "CLOCK_IN_UNAVAILABLE", message: string, public entry?: unknown) { super(message); }
}
export function clockInIdentity(body: Record<string, unknown>): ClockInIdentity {
    if (body.startTime !== undefined && (typeof body.startTime !== "string" || !Number.isFinite(Date.parse(body.startTime)))) throw new Error("A valid start time is required");
    if (body.requestId === undefined) return null; // old clients are still protected by the open-punch guard
    if (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId)) throw new Error("A valid clock-in request ID is required");
    // Hash the intent, not resolved task/rate data or a server-generated time.
    // Replays must survive later changes to project phases and dispatch plans.
    const fields = ["projectId", "costCodeId", "estimateItemId", "startTime", "latitude", "longitude", "rawNote", "suggestedScheduleTaskId", "suggestedCostCodeId", "suggestionSource", "suggestionOverridden"];
    const intent = Object.fromEntries(fields.map(field => [field, body[field] ?? null]));
    return { requestId: body.requestId, requestHash: createHash("sha256").update(JSON.stringify(intent)).digest("hex") };
}
export type ClockInReplay<T> = { requestHash: string; entry: T | null };
export function resolveClockInReplay<T>(replay: ClockInReplay<T> | null, identity: NonNullable<ClockInIdentity>): T | undefined {
    if (!replay) return undefined;
    if (replay.requestHash !== identity.requestHash) throw new ClockInConflict("REQUEST_ID_CONFLICT", "This clock-in request was already used for different details. Refresh before trying again.");
    if (!replay.entry) throw new ClockInConflict("CLOCK_IN_UNAVAILABLE", "The original clock-in is no longer available. Refresh your time entries.");
    return replay.entry;
}
export interface ClockInStore<T> {
    lock(): Promise<void>;
    replay(id: string): Promise<ClockInReplay<T> | null>;
    open(): Promise<T | null>;
    assertUnlocked(): Promise<void>;
    create(): Promise<T>;
    remember(id: string, hash: string, entry: T): Promise<void>;
}
/** Caller supplies ONE transaction already holding the payroll shared lock. */
export async function clockInGuarded<T>(store: ClockInStore<T>, identity: ClockInIdentity): Promise<T> {
    await store.lock();
    if (identity) {
        const entry = resolveClockInReplay(await store.replay(identity.requestId), identity);
        if (entry !== undefined) return entry;
    }
    const open = await store.open();
    if (open) throw new ClockInConflict("ALREADY_CLOCKED_IN", "You already have an open shift. Refresh and finish or correct that entry before clocking in again.", open);
    await store.assertUnlocked();
    const entry = await store.create();
    if (identity) await store.remember(identity.requestId, identity.requestHash, entry);
    return entry;
}
