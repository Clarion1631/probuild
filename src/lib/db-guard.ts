/**
 * Production-database guard for destructive seed / reset routines.
 *
 * Root cause of the June 2026 prod data-loss event: destructive seed scripts
 * (`prisma/seed.ts`, `/api/seed`) and e2e setup all connect to whatever
 * `DATABASE_URL` is in the environment, then run `deleteMany({})` wipes. Every
 * local `.env*` file points `DATABASE_URL` at the production Supabase project,
 * and CI wired the prod `DATABASE_URL` secret into the Playwright job — so a
 * stray seed run (local `tsx prisma/seed.ts`, `/api/seed`, or e2e) wiped real
 * clients/leads/projects/estimates and recreated them with new cuids.
 *
 * This module refuses to run those routines when the active connection string
 * points at production.
 *
 * IMPORTANT — detection is by *whole-string* substring, not host:
 * Supabase's transaction-pooler `DATABASE_URL` puts the project ref in the
 * USERNAME, not the host, e.g.
 *   postgresql://postgres.ghzdbzdnwjxazvmcefbh:****@aws-0-us-west-2.pooler.supabase.com:6543/postgres
 * A host-only check would miss the pooled URL entirely. The direct URL instead
 * carries the ref in the host (db.ghzdbzdnwjxazvmcefbh.supabase.co). Scanning
 * the full DATABASE_URL and DIRECT_URL strings catches both shapes.
 */

/** Production Supabase project ref. Appears in the prod connection string's username (pooler) or host (direct). */
export const PROD_SUPABASE_REF = "ghzdbzdnwjxazvmcefbh";

/** True if the given connection string belongs to the production database. */
export function isProdConnectionString(url: string | undefined | null): boolean {
    return typeof url === "string" && url.includes(PROD_SUPABASE_REF);
}

/** True if either DATABASE_URL or DIRECT_URL currently points at production. */
export function isProdDatabase(): boolean {
    return (
        isProdConnectionString(process.env.DATABASE_URL) ||
        isProdConnectionString(process.env.DIRECT_URL)
    );
}

/** Extract `host:port` from a connection string without exposing the password. */
function safeHostHint(url: string | undefined | null): string {
    if (!url) return "(unset)";
    const match = url.match(/@([^/?]+)/);
    return match?.[1] ?? "(unparseable)";
}

/**
 * Throw if the active database is production. Call at the top of any routine
 * that deletes/recreates data wholesale. `context` is a human label for the
 * caller (e.g. "prisma/seed.ts") used in the error message.
 */
export function assertNotProdDatabase(context: string): void {
    if (isProdDatabase()) {
        throw new Error(
            `[db-guard] Refusing to run "${context}" against the PRODUCTION database ` +
            `(Supabase project ref "${PROD_SUPABASE_REF}", host ${safeHostHint(process.env.DATABASE_URL)}). ` +
            `Destructive seed/reset routines must target a dedicated test or branch database. ` +
            `Point DATABASE_URL (and DIRECT_URL) at a non-prod database and retry.`
        );
    }
}
