/**
 * Front Desk v1 (PB-frontdesk-001) — docs/plans/FRONT-DESK-V1.md §4.
 * Shared constants and env-var reads, mirroring the shape of
 * speed-to-lead/constants.ts. The front desk FEEDS v1a intake, so its own
 * mode is never "more on" than v1a's: `frontDeskMode()` reads OFF whenever
 * `SPEED_TO_LEAD_MODE=OFF`, even if `FRONT_DESK_MODE` itself says otherwise.
 */
import { speedToLeadMode, isProduction } from "@/lib/speed-to-lead/constants";

export type FrontDeskMode = "OFF" | "TEST" | "LIVE";

/** Any unrecognized value reads as OFF — never fail open. §4's table. */
export function frontDeskMode(env: NodeJS.ProcessEnv = process.env): FrontDeskMode {
    if (speedToLeadMode(env) === "OFF") return "OFF";
    const raw = (env.FRONT_DESK_MODE ?? "").trim().toUpperCase();
    return raw === "TEST" || raw === "LIVE" ? raw : "OFF";
}

export { isProduction };

/**
 * TEST mode, or LIVE off production (v1a's `isProduction` rule, acceptance
 * test 6) — every row gets `isTest=true`, every alert gets `[TEST]`. OFF
 * itself never reaches a caller of this (every route short-circuits on OFF
 * first), so it reads false there only as a safe default.
 */
export function frontDeskIsTest(env: NodeJS.ProcessEnv = process.env): boolean {
    const mode = frontDeskMode(env);
    if (mode === "OFF") return false;
    if (mode === "TEST") return true;
    return !isProduction(env);
}

/** §4: OFF by default; only ON after the plan's booking gate (P§7). */
export function frontDeskBookingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return (env.FRONT_DESK_BOOKING ?? "").trim().toUpperCase() === "ON";
}

/** §4: the fixed miss line on the bridge — off by default (test #1 result B only). */
export function frontDeskMissLineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return (env.FRONT_DESK_MISS_LINE ?? "").trim().toUpperCase() === "ON";
}

/** §2.2 gate 1: in TEST, the invitee email's domain must be on this list. Comma-separated, lower-cased. */
export function frontDeskTestInviteeDomains(env: NodeJS.ProcessEnv = process.env): string[] {
    return (env.FRONT_DESK_TEST_INVITEE_DOMAINS ?? "")
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
}

export function frontDeskAgentId(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return env.FRONT_DESK_AGENT_ID?.trim() || undefined;
}

export function frontDeskNumberE164(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return env.FRONT_DESK_NUMBER_E164?.trim() || undefined;
}

export function frontDeskBridgeNumberE164(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return env.FRONT_DESK_BRIDGE_NUMBER_E164?.trim() || undefined;
}

export function frontDeskRichardE164(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return env.FRONT_DESK_RICHARD_E164?.trim() || undefined;
}

export function frontDeskUrgentNtfyTopic(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return env.FRONT_DESK_URGENT_NTFY_TOPIC?.trim() || undefined;
}

// ── Sizes and timeouts ─────────────────────────────────────────────────────

export const FRONT_DESK_TOOL_BODY_MAX_BYTES = 8 * 1024;
export const FRONT_DESK_POST_CALL_MAX_BYTES = 2 * 1024 * 1024;

/** §1 step 3: ElevenLabs' own rule (past) and ours (future). */
export const FRONT_DESK_WEBHOOK_SKEW_PAST_MS = 30 * 60 * 1000;
export const FRONT_DESK_WEBHOOK_SKEW_FUTURE_MS = 5 * 60 * 1000;

/** Intake writes run as explicit interactive transactions with a bounded timeout — same reasoning as v1a's INTAKE_TX_TIMEOUT_MS. */
export const FRONT_DESK_INTAKE_TX_TIMEOUT_MS = 5_000;
export const FRONT_DESK_INTAKE_TX_MAX_WAIT_MS = 5_000;

// ── Booking (§2.2, §4) ──────────────────────────────────────────────────────

export const FRONT_DESK_DAILY_BOOKING_CAP = 6;
/** §2.1: a slot is good for this long after being offered. */
export const FRONT_DESK_SLOT_TTL_MS = 10 * 60 * 1000;
/** §2.1: at most 3 offer CALLS per conversation; the 4th → offer_limit. */
export const FRONT_DESK_MAX_OFFERS_PER_CALL = 3;
/** §2.1: at most 3 slots returned per offer call. */
export const FRONT_DESK_MAX_SLOTS_PER_OFFER = 3;
/** §2.2 step 2: 3 or more booking rows for a conversation → too_many_attempts. */
export const FRONT_DESK_MAX_BOOK_ATTEMPTS = 3;
export const FRONT_DESK_CALENDLY_POST_TIMEOUT_MS = 8_000;
export const FRONT_DESK_CALENDLY_AVAILABILITY_TIMEOUT_MS = 6_000;
export const FRONT_DESK_CALENDLY_TOKEN_CHECK_TIMEOUT_MS = 6_000;
/** §2.2 step 6: a concurrent identical request polls the winner's row for up to this long. */
export const FRONT_DESK_BOOK_REPLAY_POLL_MS = 500;
export const FRONT_DESK_BOOK_REPLAY_WAIT_MS = 9_000;
export const FRONT_DESK_PACIFIC_TZ = "America/Los_Angeles";
/** §2.3: reconciler windows. */
export const FRONT_DESK_RECONCILE_SUBMITTING_MIN_AGE_MS = 2 * 60 * 1000;
export const FRONT_DESK_RECONCILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const FRONT_DESK_RECONCILE_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
export const FRONT_DESK_RECONCILE_ABSENT_GRACE_MS = 30 * 60 * 1000;

// ── Transfer bridge (§3, §4) ────────────────────────────────────────────────

export const FRONT_DESK_TRANSFER_PREPARED_TTL_MS = 60 * 1000;
export const FRONT_DESK_TRANSFER_RING_TIMEOUT_S = 15;
export const FRONT_DESK_TRANSFER_SCREEN_GATHER_TIMEOUT_S = 6;
/** §3.4 sweep: an unaccepted DIALING row older than this → MISSED + alert. */
export const FRONT_DESK_SWEEP_DIALING_MISS_MS = 90 * 1000;
/** §3.4 sweep: an accepted DIALING row older than this → CONNECTED, no alert. */
export const FRONT_DESK_SWEEP_CONNECTED_STALE_MS = 4 * 60 * 60 * 1000;

/** §4: Mon–Fri 08:00–17:00 Pacific. UNVERIFIED against Google's configured hours (open item). ISO weekday: 1=Mon..5=Fri. */
export const FRONT_DESK_TRANSFER_HOURS = { isoWeekdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 17 } as const;

// ── Text sanitization (§3.2 "screen") ───────────────────────────────────────

export const FRONT_DESK_SCREEN_TEXT_MAX_LEN = 40;

// ── Pacific time (§2.2 "Pacific time") ──────────────────────────────────────
//
// Storage is always UTC. Spoken times, the read-back fields, the daily cap's
// day boundary and the transfer hours are all America/Los_Angeles via Intl,
// which is DST-correct without a tz database dependency.

export interface PacificParts {
    year: number;
    month: number; // 1-12
    day: number;
    hour: number; // 0-23
    minute: number;
    /** ISO weekday: 1=Mon .. 7=Sun. */
    isoWeekday: number;
}

const PACIFIC_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
    timeZone: FRONT_DESK_PACIFIC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
});

const ISO_WEEKDAY_BY_SHORT: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function pacificParts(date: Date): PacificParts {
    const parts = PACIFIC_PARTS_FORMATTER.formatToParts(date);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
    // Intl renders midnight as "24" with hour12:false in some engines — normalize to 0.
    const hourRaw = Number(get("hour"));
    return {
        year: Number(get("year")),
        month: Number(get("month")),
        day: Number(get("day")),
        hour: hourRaw === 24 ? 0 : hourRaw,
        minute: Number(get("minute")),
        isoWeekday: ISO_WEEKDAY_BY_SHORT[get("weekday")] ?? 1,
    };
}

/** `YYYY-MM-DD` in Pacific — used for the daily booking cap's day boundary and the read-back guard's `date` field. */
export function pacificDateString(date: Date): string {
    const p = pacificParts(date);
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** `HH:MM` (24-hour) in Pacific — the read-back guard's `time` field. */
export function pacificTimeString(date: Date): string {
    const p = pacificParts(date);
    return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** §2.1 "spoken": e.g. "Tuesday, October 6, 9:00 AM Pacific". */
const SPOKEN_FORMATTER = new Intl.DateTimeFormat("en-US", {
    timeZone: FRONT_DESK_PACIFIC_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

export function pacificSpoken(date: Date): string {
    return `${SPOKEN_FORMATTER.format(date)} Pacific`;
}

/** §3.1 transfer hours: Mon–Fri 08:00–17:00 Pacific (inclusive start, exclusive end — 17:00 itself is outside). */
export function isWithinTransferHours(date: Date, hours: typeof FRONT_DESK_TRANSFER_HOURS = FRONT_DESK_TRANSFER_HOURS): boolean {
    const p = pacificParts(date);
    if (!(hours.isoWeekdays as readonly number[]).includes(p.isoWeekday)) return false;
    const minutesOfDay = p.hour * 60 + p.minute;
    return minutesOfDay >= hours.startHour * 60 && minutesOfDay < hours.endHour * 60;
}
