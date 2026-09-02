// $0-rate clock-out block (Phase 5 spec G2).
//
// laborCost is stamped at clock-out from the OWNER's hourlyRate. A worker whose
// rate was never entered therefore closes a shift worth $0 — and because that
// number is what payroll, job costing, and variance all read afterwards, the
// mistake is invisible until someone reconciles a pay period. Refuse the close
// instead, and leave the punch OPEN so no time is lost: the worker is still on
// the clock and gets paid once the rate is entered.
//
// ADMIN and FINANCE are exempt. They are salaried (Phase 5 spec section 7 risk
// 3) — a $0 hourly rate on those accounts is the correct value, not a gap.
//
// Spec section 7 risk 5 records the accepted downside: a punch left open past
// MAX_SHIFT_HOURS becomes edit-only to close. The manager badge on
// /manager/time-entries and the manager-facing message below are the
// mitigations. The documented fallback, if this bites in practice, is
// close-and-flag instead of block.

import { NextResponse } from "next/server";

export const ZERO_RATE_BLOCKED_CODE = "ZERO_RATE_BLOCKED";

/** Roles paid by the hour. ADMIN/FINANCE are salaried and exempt. */
export const HOURLY_PAID_ROLES = ["FIELD_CREW", "MANAGER"] as const;

export const ZERO_RATE_WORKER_MESSAGE =
    "Your pay rate isn't set up yet. Tell your manager — your time is still on the clock and will be paid once the rate is entered.";

export function zeroRateManagerMessage(ownerName: string | null | undefined): string {
    return `Set an hourly rate for ${ownerName?.trim() || "this team member"} on Company → Team Members before closing this entry.`;
}

/** True when closing this entry would stamp a $0 labor cost onto an hourly worker's shift. */
export function zeroRateBlocks(owner: { role?: string | null; hourlyRate: number }): boolean {
    if (!owner.role) return false;
    if (!(HOURLY_PAID_ROLES as readonly string[]).includes(owner.role)) return false;
    return !(owner.hourlyRate > 0);
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
