// Input hardening for the two help-widget submit routes (review round 5, item 10).
//
// These endpoints became reachable by EVERY activated staff account and by the
// crew app's Bearer token in this phase, and each submission creates a GitHub
// issue. That widened both the input surface and the blast radius of a stuck
// retry loop, so the payload is bounded and the caller is throttled.
//
// Pure except for the throttle's row count, which is injected — so the limits
// are testable without a database.

export const HELP_TITLE_MAX = 200;
export const HELP_DESCRIPTION_MAX = 5_000;
export const HELP_STEPS_MAX = 5_000;
/** Submissions per user per hour. A human reporting bugs never approaches this; a retry loop does. */
export const HELP_SUBMISSIONS_PER_HOUR = 5;
export const HELP_THROTTLE_WINDOW_MS = 60 * 60 * 1000;

export type HelpSubmissionInput = {
    title?: unknown;
    description?: unknown;
    steps?: unknown;
    currentPage?: unknown;
    conversationId?: unknown;
};

export type HelpSubmissionCheck =
    | { ok: true; title: string; description: string; steps: string | null; currentPage: string | null }
    | { ok: false; status: number; error: string };

function readString(value: unknown): string | null {
    return typeof value === "string" ? value.trim() : null;
}

/**
 * Validate a submission body. Length limits are enforced rather than truncated:
 * silently cutting a bug report at 200 characters loses the part that mattered,
 * and the caller cannot tell it happened.
 */
export function checkHelpSubmission(body: HelpSubmissionInput): HelpSubmissionCheck {
    const title = readString(body.title);
    const description = readString(body.description);
    if (!title || !description) {
        return { ok: false, status: 400, error: "Missing required fields" };
    }
    if (title.length > HELP_TITLE_MAX) {
        return { ok: false, status: 400, error: `Title must be ${HELP_TITLE_MAX} characters or fewer.` };
    }
    if (description.length > HELP_DESCRIPTION_MAX) {
        return {
            ok: false,
            status: 400,
            error: `Description must be ${HELP_DESCRIPTION_MAX} characters or fewer.`,
        };
    }
    const steps = readString(body.steps);
    if (steps && steps.length > HELP_STEPS_MAX) {
        return { ok: false, status: 400, error: `Steps must be ${HELP_STEPS_MAX} characters or fewer.` };
    }
    const currentPage = readString(body.currentPage);
    return { ok: true, title, description, steps: steps || null, currentPage: currentPage || null };
}

/** Instant the throttle window opens. Callers count this user's submissions since then. */
export function throttleWindowStart(now: Date = new Date()): Date {
    return new Date(now.getTime() - HELP_THROTTLE_WINDOW_MS);
}

export function isThrottled(recentCount: number): boolean {
    return recentCount >= HELP_SUBMISSIONS_PER_HOUR;
}

export const HELP_THROTTLED_MESSAGE = `That's ${HELP_SUBMISSIONS_PER_HOUR} reports in an hour — give it a few minutes before sending another. Nothing was lost.`;

/**
 * Read a JSON body without throwing. A malformed body is a 400, not a 500: the
 * crew app retries on 5xx, so an unparseable payload would become a loop.
 */
export async function readJsonBody(req: { json(): Promise<unknown> }): Promise<{ ok: true; body: any } | { ok: false }> {
    try {
        const body = await req.json();
        if (!body || typeof body !== "object") return { ok: false };
        return { ok: true, body };
    } catch {
        return { ok: false };
    }
}
