// $0-rate clock-out block (Phase 5 spec G2).
//
// laborCost is stamped at clock-out from the OWNER's hourlyRate. A worker whose
// rate was never entered therefore closes a shift worth $0 — and because that
// number is what payroll, job costing, and variance all read afterwards, the
// mistake is invisible until someone reconciles a pay period. Refuse the close
// instead, and leave the punch OPEN so no time is lost: the worker is still on
// the clock and gets paid once the rate is entered.
//
// THE $0 CLOSE IS REFUSED FOR EVERYONE, worker and office alike. An earlier
// revision let a manager close at $0 automatically and merely flagged it; that
// made the silent-$0-shift the DEFAULT outcome of an ordinary manager close,
// which is the thing this guard exists to prevent. The office still has a way
// out, but it is now a DELIBERATE, separate action — the caller has to pass
// `acknowledgeZeroRate`, which is only reachable from the manager UI's explicit
// "close at $0 and flag for payroll" control, and which stamps needsReview.
//
// THE RULE IS BLOCK-BY-DEFAULT, EXEMPT BY EXCEPTION. An earlier version listed
// the roles that ARE hourly and blocked only those, which fails OPEN for any
// role added later — a new role would silently book $0 shifts. Now anything
// without a rate is blocked unless it is positively known to be salaried:
//
//   - role ADMIN or FINANCE (salaried by role — see spec section 7 risk 3), or
//   - an email on the salaried list in payroll-config.ts.
//
// The email exemption is load-bearing, not belt-and-braces: CJ and Richard are
// MANAGERs in ProBuild and salaried in Gusto, so a role-only rule would have
// left them permanently unable to clock out with a correct $0 rate, and there
// is no sweeper that auto-closes a stuck punch.
//
// Spec section 7 risk 5 records the accepted downside: a punch left open past
// MAX_SHIFT_HOURS becomes edit-only to close. The manager badge on
// /manager/time-entries and the manager-facing message below are the
// mitigations. The documented fallback, if this bites in practice, is
// close-and-flag instead of block.

import { NextResponse } from "next/server";
import { isSalariedEmail } from "./payroll-config";

export const ZERO_RATE_BLOCKED_CODE = "ZERO_RATE_BLOCKED";

/**
 * Roles that are salaried BY ROLE and so exempt from the block. Everything
 * else is treated as hourly — including any role added in future, which is the
 * point of listing the exemptions rather than the hourly roles.
 */
export const SALARIED_BY_ROLE = ["ADMIN", "FINANCE"] as const;

/**
 * Roles that belong on the payroll roster even with no hours in a period (a
 * crew member who worked zero hours still gets a 0.00 row in the Gusto file).
 * A ROSTER question, not the block rule — do not reuse it as one.
 *
 * EMPLOYEE is a LEGACY role value. It is not in ROLE_LABELS/ROLES
 * (src/lib/permissions.ts), so nothing can create one today, but it is a real
 * branch in access-rules.ts's permission defaults and in schedule-core's
 * financial redaction, which means rows can still carry it. It is hourly.
 */
export const HOURLY_PAID_ROLES = ["FIELD_CREW", "EMPLOYEE", "MANAGER"] as const;

export const ZERO_RATE_WORKER_MESSAGE =
    "Your pay rate isn't set up yet, so this shift can't be closed from here. Tell the office — they can set your rate or close the punch for you. Your time is safe and you'll be paid once the rate is in.";

export function zeroRateManagerMessage(ownerName: string | null | undefined): string {
    return `Set an hourly rate for ${ownerName?.trim() || "this team member"} on Company → Team Members before closing this entry, or close it explicitly at $0 and flag it for payroll.`;
}

/** Review note stamped on a punch a MANAGER closed at a $0 rate, so payroll cannot miss it. */
export const ZERO_RATE_REVIEW_NOTE = "Closed at a $0 pay rate — set the rate and recheck this entry";

/**
 * A MANAGER closing someone else's $0-rate punch is ALLOWED, and flagged.
 *
 * The worker-side block is the right call (the phone cannot fix a rate), but
 * applying it to the office too created a punch nobody could close: past
 * MAX_SHIFT_HOURS the clock-out path refuses it as well, and nothing sweeps a
 * stranded punch. So the office always has a way out, and the flag is what
 * stops the $0 cost from being silent — /manager/time-entries surfaces it and
 * the payroll export REFUSES to run while it is set.
 *
 * Composes onto whatever reviewReason the meal/rest notices already wrote,
 * using the same "; " convention as src/lib/wa-breaks.ts.
 */
export function appendZeroRateReview(existingReviewReason: unknown): {
    needsReview: true;
    reviewReason: string;
} {
    const parts = String(existingReviewReason ?? "")
        .split("; ")
        .map((part) => part.trim())
        .filter(Boolean);
    if (!parts.includes(ZERO_RATE_REVIEW_NOTE)) parts.push(ZERO_RATE_REVIEW_NOTE);
    return { needsReview: true, reviewReason: parts.join("; ") };
}

/**
 * True when closing this entry would stamp a $0 labor cost onto someone who is
 * supposed to be paid by the hour. Block by default; exempt only the salaried.
 */
export const PAY_TYPE_HOURLY = "HOURLY";
export const PAY_TYPE_SALARY = "SALARY";

/**
 * The ONLY two values User.payType may hold, mirrored by the DB CHECK
 * `User_payType_check`. Anything else is treated as UNKNOWN, never as a
 * default — an unrecognised value must block the export, not silently pick a
 * side and mis-pay somebody.
 */
export const PAY_TYPES = [PAY_TYPE_HOURLY, PAY_TYPE_SALARY] as const;

export function isKnownPayType(value: unknown): value is "HOURLY" | "SALARY" {
    return value === PAY_TYPE_HOURLY || value === PAY_TYPE_SALARY;
}

/**
 * Order matters: the STORED column wins over the env list, and both win over
 * role. `User.payType` is the answer a human gave; PAYROLL_SALARIED_EMAILS is a
 * fallback for rows nobody has answered yet, and it is fail-open by nature (an
 * email absent from a config string looks exactly like "hourly").
 *
 * An explicit HOURLY beats the role default too — that is the point of storing
 * it. Somebody has to be able to say "this ADMIN really is paid by the hour".
 */
export function isSalariedOwner(owner: {
    role?: string | null;
    email?: string | null;
    payType?: string | null;
}): boolean {
    if (owner.payType === PAY_TYPE_SALARY) return true;
    if (owner.payType === PAY_TYPE_HOURLY) return false;
    // Anything else (including a value the DB CHECK would reject) falls through
    // to role/env rather than being trusted.
    if (owner.role && (SALARIED_BY_ROLE as readonly string[]).includes(owner.role)) return true;
    // A salaried MANAGER (CJ, Richard) has a CORRECT $0 hourly rate.
    return isSalariedEmail(owner.email);
}

export function zeroRateBlocks(owner: {
    role?: string | null;
    email?: string | null;
    payType?: string | null;
    hourlyRate: number;
}): boolean {
    // A real rate settles it, whoever they are.
    if (owner.hourlyRate > 0) return false;
    return !isSalariedOwner(owner);
}

/**
 * 422 with the audience-appropriate message: the worker sees "your time is
 * still on the clock"; a manager closing someone else's punch sees where to go
 * and fix it. Same `code` either way so clients branch on one value.
 */
export function zeroRateBlockedResponse(options: { closerIsOwner: boolean; ownerName?: string | null }): NextResponse {
    return NextResponse.json(
        {
            error: options.closerIsOwner ? ZERO_RATE_WORKER_MESSAGE : zeroRateManagerMessage(options.ownerName),
            code: ZERO_RATE_BLOCKED_CODE,
        },
        { status: 422 }
    );
}
