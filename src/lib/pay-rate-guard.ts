// $0-rate clock-out block (Phase 5 spec G2).
//
// laborCost is stamped at clock-out from the OWNER's hourlyRate. A worker whose
// rate was never entered therefore closes a shift worth $0 — and because that
// number is what payroll, job costing, and variance all read afterwards, the
// mistake is invisible until someone reconciles a pay period. Refuse the close
// instead, and leave the punch OPEN so no time is lost: the worker is still on
// the clock and gets paid once the rate is entered.
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
 */
export const HOURLY_PAID_ROLES = ["FIELD_CREW", "MANAGER"] as const;

export const ZERO_RATE_WORKER_MESSAGE =
    "Your pay rate isn't set up yet. Tell your manager — your time is still on the clock and will be paid once the rate is entered.";

export function zeroRateManagerMessage(ownerName: string | null | undefined): string {
    return `Set an hourly rate for ${ownerName?.trim() || "this team member"} on Company → Team Members before closing this entry.`;
}

/**
 * True when closing this entry would stamp a $0 labor cost onto someone who is
 * supposed to be paid by the hour. Block by default; exempt only the salaried.
 */
export function isSalariedOwner(owner: { role?: string | null; email?: string | null }): boolean {
    if (owner.role && (SALARIED_BY_ROLE as readonly string[]).includes(owner.role)) return true;
    // A salaried MANAGER (CJ, Richard) has a CORRECT $0 hourly rate.
    return isSalariedEmail(owner.email);
}

export function zeroRateBlocks(owner: {
    role?: string | null;
    email?: string | null;
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
