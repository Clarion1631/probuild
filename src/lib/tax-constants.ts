// Client-safe tax constants (no Prisma imports — the portal client bundles this).

// Rate used when CompanySettings has no default sales tax configured. The portal
// DISPLAY and the server-side estimate gross-up must agree on this number: if the
// client is shown tax at this rate, billing has to collect it at the same rate.
export const FALLBACK_SALES_TAX_RATE_PERCENT = 8.8;
