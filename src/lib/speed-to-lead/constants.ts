/**
 * Speed-to-Lead v1 (PB-leads-001) — shared constants and env-var reads.
 *
 * Every timing/deadline number here comes straight from
 * docs/plans/SPEED-TO-LEAD-SPEC.md so there is exactly one place that could
 * disagree with the spec, and it is this one.
 */

// ── Timing (spec "Goals", "Template A", "Approval", "Suppression") ─────────

/** Goal 3: push to Justin within this long of a web lead or Voice event. */
export const PUSH_DEADLINE_MS = 5 * 60 * 1000;
/** Goal 4: Template A must commit within this long of the webhook intake. */
export const TEMPLATE_A_DEADLINE_MS = 15 * 60 * 1000;
/** Approval: a personal approval must commit within this long or it expires. */
export const APPROVAL_COMMIT_WINDOW_MS = 30 * 60 * 1000;
/** Approval: an un-acted-on draft expires after this long. */
export const DRAFT_EXPIRY_MS = 72 * 60 * 60 * 1000;
/** Intake: a WEB_EMAIL_FALLBACK row waits this long past the email's receive time before the cron may promote it. */
export const FALLBACK_DUE_DELAY_MS = 10 * 60 * 1000;
/** Suppression/freshness: a commit needs a successful poll finished within this long. */
export const FRESHNESS_POLL_MAX_AGE_MS = 5 * 60 * 1000;
/** Suppression/freshness: absolute ceiling — any dispatch needs a successful poll within this long, full stop. */
export const FRESHNESS_POLL_HARD_CEILING_MS = 10 * 60 * 1000;
/** Dispatch: a DISPATCHING row older than this with no provider answer is UNKNOWN_DELIVERY. */
export const DISPATCHING_STALE_MS = 2 * 60 * 1000;
/** Dispatch: reconciliation checkpoints for an UNKNOWN_DELIVERY attempt (minutes after the attempt). */
export const RECONCILE_CHECKPOINTS_MIN = [1, 5, 30] as const;
/** Dispatch: send-again is offered once an UNKNOWN_DELIVERY attempt has aged past this. */
export const UNKNOWN_DELIVERY_SEND_AGAIN_MS = 30 * 60 * 1000;
/** Release Goal 8: follow-up reminder offsets, in business days. */
export const FOLLOWUP_BUSINESS_DAY_OFFSETS = [1, 3] as const;

/** Template A substitution: {firstName} falls back to "there" past this length or if it holds no letters/apostrophe/hyphen. */
export const FIRST_NAME_MAX_LEN = 30;

/** Suppression: opt-out phrases (case-insensitive, matched against quote-stripped new text). */
export const OPT_OUT_PHRASES = ["stop", "unsubscribe", "remove me", "no thanks", "not interested"];

/** Triage REAL: minimum seconds between page render and form submit. */
export const MIN_RENDER_TO_SUBMIT_SECONDS = 3;
/** Triage REAL: minimum letters (a-z, case-insensitive) required in the description. */
export const MIN_DESCRIPTION_LETTERS = 10;

/** Webhook signing: accepted clock skew for `timestamp.body` HMAC verification. */
export const WEBHOOK_SKEW_MS = 5 * 60 * 1000;

// ── Modes (spec "Release — Mode") ───────────────────────────────────────────

export type SpeedToLeadMode = "OFF" | "TEST" | "LIVE";

/** Any unrecognized value reads as OFF — never fail open. */
export function speedToLeadMode(env: NodeJS.ProcessEnv = process.env): SpeedToLeadMode {
    const raw = (env.SPEED_TO_LEAD_MODE ?? "").trim().toUpperCase();
    return raw === "TEST" || raw === "LIVE" ? raw : "OFF";
}

/** LIVE only ever has effect in production — everywhere else it behaves like TEST. */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.VERCEL_ENV === "production";
}

/** The single approver's email — every Justin-only gate compares against this. */
export function approverEmail(env: NodeJS.ProcessEnv = process.env): string {
    return (env.SPEED_TO_LEAD_APPROVER_EMAIL ?? "").trim().toLowerCase();
}

export function isApprover(sessionEmail: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
    const expected = approverEmail(env);
    if (!expected || !sessionEmail) return false;
    return sessionEmail.trim().toLowerCase() === expected;
}

/** Template A is gated by its own flag, separately from mode (spec Goal 4, Release R4). */
export function templateAEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return (env.SPEED_TO_LEAD_TEMPLATE_A ?? "").trim().toLowerCase() === "on";
}

// ── Daily cap (spec Dispatch — "a conditional increment") ──────────────────

/** Absent/invalid env means "no cap configured" -> Number.POSITIVE_INFINITY, never 0 (0 would silently block every send). */
export function dailySendCap(env: NodeJS.ProcessEnv = process.env): number {
    const raw = Number(env.SPEED_TO_LEAD_DAILY_CAP ?? "");
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : Number.POSITIVE_INFINITY;
}

// ── TEST-mode allowlist (spec Dispatch "Kill switch", Release "Test identity") ─

/** Comma-separated recipient emails TEST mode / isTest leads may ever be sent to. Normalized lowercase/trimmed. */
export function testAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
    const raw = env.SPEED_TO_LEAD_TEST_ALLOWLIST ?? "";
    return new Set(raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
}

export function isAllowlistedRecipient(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
    return testAllowlist(env).has(email.trim().toLowerCase());
}

// ── Fixed content (spec "Context", "Template A") ───────────────────────────

export const SITE_FIXED_PHONE = "+1 (360) 200-1521";
export const RICHARD_CALENDLY_PREFIX = "https://calendly.com/rlord-goldentouchremodeling/";
export const COMMERCIAL_FOOTER =
    "Golden Touch Remodeling, 5305 NE 121st Ave Suite 310, Vancouver, WA 98682. " +
    "If you'd rather not hear from me, reply 'no thanks' and I'll stop.";
export const DISPATCH_FROM_ADDRESS = "gtrsupport@goldentouchremodeling.com";
export const MESSAGE_ID_DOMAIN = "goldentouchremodeling.com";

// ── Triage: service area (spec Triage — "a service-area city or zip, or none given") ─
// Golden Touch Remodeling is based in Vancouver, WA. This default list is a
// starting point, not authoritative business data — override with
// SPEED_TO_LEAD_SERVICE_AREA_CITIES / _ZIP_PREFIXES (comma-separated) without a
// redeploy. A wrong classification here only routes a REAL-otherwise lead to
// REVIEW (spec: "If any check fails, the lead is REVIEW with reasons stored"),
// never a hard rejection, so this list being imperfect is a review-queue cost,
// not a correctness bug.
const DEFAULT_SERVICE_AREA_CITIES = [
    "vancouver", "camas", "battle ground", "ridgefield", "washougal",
    "la center", "yacolt", "brush prairie", "hazel dell", "felida",
    "portland", "gresham", "troutdale", "fairview", "beaverton",
];
const DEFAULT_SERVICE_AREA_ZIP_PREFIXES = ["986", "970", "972", "971"];

export function serviceAreaCities(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = env.SPEED_TO_LEAD_SERVICE_AREA_CITIES;
    if (!raw) return DEFAULT_SERVICE_AREA_CITIES;
    return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

export function serviceAreaZipPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = env.SPEED_TO_LEAD_SERVICE_AREA_ZIP_PREFIXES;
    if (!raw) return DEFAULT_SERVICE_AREA_ZIP_PREFIXES;
    return raw.split(",").map(s => s.trim()).filter(Boolean);
}
