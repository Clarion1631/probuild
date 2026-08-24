/**
 * Roles allowed to review/approve/edit/delete expenses. Field crew SUBMIT expenses but
 * may not review their own. Kept here so every expense-mutation route gates identically.
 * (DB roles today: ADMIN, FIELD_CREW, FINANCE. MANAGER is included for forward-compat.)
 */
export const EXPENSE_REVIEWER_ROLES = ["ADMIN", "MANAGER", "FINANCE"] as const;
