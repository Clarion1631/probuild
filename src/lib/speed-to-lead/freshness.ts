import { FRESHNESS_POLL_MAX_AGE_MS, FRESHNESS_POLL_HARD_CEILING_MS } from "./constants";

/**
 * Spec "Suppression and cancellation — Freshness":
 * "A can commit only after a successful inbox poll that started after the
 * intake's server receive time and finished within the last 5 minutes. Any
 * dispatch needs a successful poll within 10 minutes. Otherwise the message
 * is BLOCKED ('inbox check stale')."
 */
export interface PollHealth {
    lastPollStartedAt: Date | null;
    lastPollFinishedAt: Date | null;
    lastPollOk: boolean | null;
}

export interface FreshnessCheck {
    fresh: boolean;
    reason?: string;
}

/** The looser rule every dispatch needs, personal replies included. */
export function anyDispatchFreshness(health: PollHealth, now: Date = new Date()): FreshnessCheck {
    if (!health.lastPollOk || !health.lastPollFinishedAt) return { fresh: false, reason: "no successful poll recorded" };
    const age = now.getTime() - health.lastPollFinishedAt.getTime();
    if (age > FRESHNESS_POLL_HARD_CEILING_MS) return { fresh: false, reason: "last successful poll is more than 10 minutes old" };
    return { fresh: true };
}

/** The stricter rule Template A alone needs, on top of the looser one above. */
export function templateAFreshness(health: PollHealth, intakeReceivedAt: Date, now: Date = new Date()): FreshnessCheck {
    const loose = anyDispatchFreshness(health, now);
    if (!loose.fresh) return loose;
    if (!health.lastPollStartedAt || health.lastPollStartedAt.getTime() <= intakeReceivedAt.getTime()) {
        return { fresh: false, reason: "no poll has started since this lead's intake" };
    }
    const age = now.getTime() - (health.lastPollFinishedAt as Date).getTime();
    if (age > FRESHNESS_POLL_MAX_AGE_MS) return { fresh: false, reason: "last successful poll finished more than 5 minutes ago" };
    return { fresh: true };
}
