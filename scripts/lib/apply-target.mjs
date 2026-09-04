// THE ONE PLACE THAT ANSWERS "WHICH DATABASE AM I ABOUT TO WRITE TO?"
//
// Shared by every script that can change production data — the DDL apply
// script and the money backfill both import it (Codex round 48, item 5). It
// was extracted rather than copied because the two had already drifted once:
// the apply script grew `--target`, a project-ref check and a redacted
// identity banner, while `backfill-expense-attribution.ts` still took whatever
// `DATABASE_URL` happened to be in the shell and wrote money columns with it.
// A second copy of a guard is a guard that will be half-updated.
//
// PURE, AND INERT ON IMPORT. There is no `main()` here and nothing runs at
// module scope: importing this file reads no environment, opens no connection
// and executes no SQL. `tests/apply-scripts-inert-on-import.test.ts` pins that
// (scripts/apply-*.mjs is checked for its entrypoint guard; this file is
// checked for having no entrypoint at all).
import fs from "node:fs";
import dns from "node:dns";

/**
 * WHICH DATABASE, SAID OUT LOUD (cross-PR rule, round 46).
 *
 * `resolveDatabaseUrl` above prefers an AMBIENT `DATABASE_URL`. That is the
 * right default for a driver that hands the script a throwaway container, and
 * the wrong one for a person: a developer with a local Postgres in their shell
 * runs this, watches every "verified ..." line print, and merges believing
 * production has the columns. Nothing in the output contradicts them —
 * `--expect-db postgres --expect-host ...` can be satisfied by a local server
 * as easily as by the real one, because the operator supplies both sides of
 * that comparison.
 *
 * So the TARGET is now an explicit argument, and each target decides where the
 * URL may come from:
 *
 *   * `--target prod` reads `.env.production.local` and IGNORES the ambient
 *     `DATABASE_URL` entirely — the file Vercel writes is the only thing that
 *     can name production — and additionally requires the pooler host and the
 *     production baseline migration row.
 *   * `--target ci` is the throwaway container: ambient `DATABASE_URL`, no
 *     baseline row (a database built from `migrate deploy` in a fresh
 *     container has one, but a hand-rolled fixture may not), and it REFUSES a
 *     Supabase-looking URL so the CI path can never be pointed at prod.
 *
 * Both are named on the command line. There is deliberately no default: a
 * missing `--target` is an error, not a guess.
 */
export const APPLY_TARGETS = {
    prod: {
        envFile: ".env.production.local",
        allowAmbient: false,
        requireBaseline: true,
        hostMustMatch: /(^|\.)pooler\.supabase\.com$/i,
        hostDescription: "the Supabase pooler",
        // THE HOST IS NOT THE IDENTITY. Supabase's pooler hostnames are shared
        // REGIONALLY — `aws-0-us-west-2.pooler.supabase.com` is every project
        // in that region — and the database is called `postgres` in all of
        // them. A migrated staging clone therefore matches the host, the
        // database name AND the baseline row. What actually names the project
        // is the URL's USERNAME: `postgres.<project-ref>`.
        requireProjectRef: true,
    },
    ci: {
        envFile: null,
        allowAmbient: true,
        requireBaseline: false,
        hostMustNotMatch: /supabase\.(co|com)$/i,
        hostDescription: "a throwaway container",
        // A container has no project ref, and requiring one would only mean
        // inventing a fake to satisfy the check.
        requireProjectRef: false,
    },
};

/** The migration whose presence proves this is the real, baselined database. */
export const PRODUCTION_BASELINE_MIGRATION = "20260814000000_baseline_production";

/**
 * `--target <name>` out of an argv array. Returns the name or an error string;
 * never throws, so `main()` can print and exit rather than stack-trace.
 */
export function parseTarget(argv) {
    const idx = argv.indexOf("--target");
    if (idx < 0) {
        return { error: `--target is required: one of ${Object.keys(APPLY_TARGETS).join(", ")}.` };
    }
    const name = argv[idx + 1];
    if (!name || !Object.prototype.hasOwnProperty.call(APPLY_TARGETS, name)) {
        return { error: `Unknown --target ${JSON.stringify(name ?? null)}: expected one of ${Object.keys(APPLY_TARGETS).join(", ")}.` };
    }
    return { name, target: APPLY_TARGETS[name] };
}

/**
 * The URL this target is allowed to use.
 *
 * `env` and the two fs functions are parameters so the rule can be tested
 * without a `.env.production.local` on the machine running the tests — and so
 * the "ambient DATABASE_URL is ignored for prod" claim is checked rather than
 * asserted.
 */
export function resolveTargetDatabaseUrl(
    name,
    { env = process.env, exists = fs.existsSync, read = file => fs.readFileSync(file, "utf8") } = {},
) {
    const target = APPLY_TARGETS[name];
    if (!target) return { error: `Unknown target ${name}.` };
    if (target.envFile) {
        if (!exists(target.envFile)) {
            return { error: `--target ${name} reads ${target.envFile}, which does not exist. Run: vercel env pull ${target.envFile}` };
        }
        const match = String(read(target.envFile)).match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (!match) return { error: `${target.envFile} has no DATABASE_URL.` };
        // Deliberately NOT falling back to the ambient value: for this target
        // the file is the only authority, and a missing key is an error rather
        // than a reason to use whatever is in the shell.
        return { url: match[1], from: target.envFile };
    }
    if (!env.DATABASE_URL) return { error: `--target ${name} needs DATABASE_URL in the environment.` };
    return { url: env.DATABASE_URL, from: "process.env.DATABASE_URL" };
}

/**
 * Does the URL's HOST agree with what this target is? Checked on the URL and
 * not on `inet_server_addr()`, because the latter is an IP address and "is
 * this the pooler" is a question about the name we dialled.
 */
export function targetHostVerdict(name, url) {
    const target = APPLY_TARGETS[name];
    if (!target) return `Unknown target ${name}.`;
    let host;
    try {
        host = new URL(url).hostname;
    } catch {
        return `The resolved DATABASE_URL is not a valid URL.`;
    }
    if (target.hostMustMatch && !target.hostMustMatch.test(host)) {
        return `--target ${name} expects ${target.hostDescription}, but the URL points at ${host}.`;
    }
    if (target.hostMustNotMatch && target.hostMustNotMatch.test(host)) {
        return `--target ${name} must never point at ${host} — that is production.`;
    }
    return null;
}

/**
 * The Supabase PROJECT REF out of a connection URL, or null.
 *
 * The pooler username is `postgres.<project-ref>`; a direct connection uses a
 * bare `postgres` with the ref in the HOST (`db.<ref>.supabase.co`). Both are
 * read, because a future change of connection style must not silently turn the
 * check off.
 */
export function projectRefFromUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    const user = decodeURIComponent(parsed.username ?? "");
    const dotted = /^postgres\.([a-z0-9]+)$/i.exec(user);
    if (dotted) return dotted[1];
    const host = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(parsed.hostname ?? "");
    return host ? host[1] : null;
}

/**
 * Is this the project the operator meant? `APPLY_EXPECT_PROJECT_REF` is the
 * shared name every apply script uses, so setting it once covers all of them.
 *
 * UNSET IS A REFUSAL, not a skip. A guard that disables itself when its input
 * is missing protects nothing on the machine that matters — the one where
 * somebody is running this in a hurry.
 */
export function projectRefVerdict(name, url, env = process.env) {
    const target = APPLY_TARGETS[name];
    if (!target?.requireProjectRef) return null;
    const expected = (env.APPLY_EXPECT_PROJECT_REF ?? "").trim();
    if (!expected) {
        return `--target ${name} requires APPLY_EXPECT_PROJECT_REF (the Supabase project ref, e.g. the value in postgres.<ref>). Set it and re-run.`;
    }
    const actual = projectRefFromUrl(url);
    if (!actual) {
        return `--target ${name} could not read a project ref from the connection URL — expected a postgres.<ref> username or a db.<ref>.supabase.co host.`;
    }
    if (actual !== expected) {
        return `REFUSING: this URL is for project ${actual}, not ${expected}. The pooler host and the database name are shared across projects in a region, so they cannot tell production from a staging clone.`;
    }
    return null;
}

/** The one line printed before any DDL, with the credentials removed. */
export function targetBanner(name, { url, from, db, host }) {
    const ref = projectRefFromUrl(url);
    return (
        `TARGET ${name}: db="${db}" server="${host || "(local socket)"}" ` +
        `project="${ref ?? "(none)"}" url=${maskUrl(url)} (from ${from})`
    );
}

export function maskUrl(url) {
    return url.replace(/:[^:@]*@/, ":****@");
}

/**
 * An IPv4-mapped IPv6 address is an IPv4 address written another way.
 *
 * Postgres reports `::ffff:10.0.0.5` or `10.0.0.5` for the same server
 * depending on how the listener is bound, and a resolver answers with the plain
 * form, so both sides are normalised before they are compared.
 */
export function normalizeServerHost(host) {
    const value = String(host ?? "").trim();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
    return mapped ? mapped[1] : value;
}

/** `localhost` is these two addresses by definition — no lookup, and none in tests. */
export const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"];

/** The real resolver. Used only on the live path; every test injects its own. */
export async function lookupAddresses(hostname) {
    const records = await dns.promises.lookup(hostname, { all: true });
    return records.map(record => record.address);
}

/** The URL's own hostname, or "" if it is not a URL. */
export function urlHostname(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
}

/**
 * THROUGH THE POOLER, THE SERVER THAT ANSWERS IS THE PROJECT'S OWN DATABASE.
 *
 * Measured 2026-09-04, not assumed: aws-0-us-west-2.pooler.supabase.com
 * resolves to three IPv4 addresses (54.70.143.232, 35.160.209.8,
 * 44.238.118.41) and publishes no AAAA at all, while production's
 * `inet_server_addr()` reports 2600:1f13:838:6e45:7ee0:268:15b9:d263 — which is
 * exactly the AAAA of db.ghzdbzdnwjxazvmcefbh.supabase.co. Supavisor hands the
 * session to the project database, and it is that database, not the pooler,
 * that answers `current_database()` and `inet_server_addr()`. So resolving
 * `--expect-host` ALONE still refuses production: the project's direct host has
 * to be resolved too.
 *
 * This SHARPENS the guard rather than widening it. `<project-ref>` comes from
 * the URL username, and `projectRefVerdict` has already refused unless that ref
 * equals APPLY_EXPECT_PROJECT_REF — so accepting this address says "you reached
 * the database of the project you named", which is a stronger claim than "you
 * reached something behind the regional pooler", which is shared.
 *
 * Empty unless the URL is a production pooler URL carrying a parseable ref:
 * there is nothing to widen to, and nothing is widened. The pooler pattern is
 * read off `APPLY_TARGETS.prod` rather than restated, so there is one copy of
 * it in this file.
 *
 * Same rule, same wording, as scripts/apply-phase2-receipt-queue.mjs — the two
 * are siblings and must not drift.
 */
export function directDbHostForUrl(url) {
    const ref = projectRefFromUrl(url);
    if (!ref) return "";
    const host = urlHostname(url);
    return host && APPLY_TARGETS.prod.hostMustMatch.test(host) ? `db.${ref}.supabase.co` : "";
}

/**
 * THE SERVER ANSWERS WITH AN ADDRESS; `--expect-host` IS A NAME.
 *
 * The comment above `targetHostVerdict` has always said the identity cannot
 * rest on `inet_server_addr()`, because that is an ADDRESS while
 * `--expect-host` is a NAME. The check underneath compared the two as strings
 * anyway, so on production it could never pass and refused every real run (the
 * sibling apply-receipt-intake printed exactly that refusal on 2026-09-04).
 *
 * Returns the LABEL of the rule that matched, or null. A label is a fact about
 * how the answer was reached, and the caller prints it:
 *
 *   "exact"       the operator typed the literal address the server reported.
 *   "loopback"    --expect-host is localhost and the server answered from 127.0.0.1 / ::1.
 *   "dns"         --expect-host resolves to the address the server answered from.
 *   "project-db"  `directHost` — the project's own database, which is what
 *                 answers behind the pooler — resolves to that address.
 *   "unix-socket" the server reported NO address (a local socket has none) and
 *                 the URL's own hostname is the expected one.
 *
 * `resolve` is injected so unit tests never touch DNS; a resolver that throws
 * propagates, and the caller turns it into a refusal, because an unanswerable
 * question is not a yes. `urlHost` is consulted for the socket case ONLY: it
 * describes what was DIALLED rather than what answered, so it is the weakest of
 * the five and is never allowed to rescue a connection that did report an
 * address. `directHost` is passed in (from `directDbHostForUrl`) rather than
 * derived here, so this function knows nothing about Supabase and a caller
 * cannot widen the set by accident.
 */
export async function targetHostMatches(actualHost, expectHost, resolve = lookupAddresses, urlHost = "", directHost = "") {
    const expect = String(expectHost ?? "").trim();
    // Nothing to verify against is a refusal, never a match. (Callers already
    // require --expect-host; this makes the helper safe on its own terms.)
    if (!expect) return null;
    if (String(actualHost ?? "") === String(expectHost ?? "")) return "exact";
    const actual = normalizeServerHost(actualHost);
    if (actual === "") {
        return String(urlHost ?? "").trim().toLowerCase() === expect.toLowerCase() ? "unix-socket" : null;
    }
    if (/^localhost$/i.test(expect)) return LOOPBACK_ADDRESSES.includes(actual) ? "loopback" : null;
    const resolvesToActual = async name => {
        const addresses = await resolve(name);
        return (addresses ?? []).some(address => normalizeServerHost(address) === actual);
    };
    if (await resolvesToActual(expect)) return "dns";
    const direct = String(directHost ?? "").trim();
    if (direct && await resolvesToActual(direct)) return "project-db";
    return null;
}

/**
 * The DATABASE-NAME half, still EXACT and still the same rule. Split out only
 * so `targetMatches` and `verifyTargetIdentity` cannot drift on it.
 */
export function targetDbMatches(actual, expectDb) {
    if (!actual || typeof actual !== "object") return false;
    return String(actual.db ?? "") === String(expectDb ?? "");
}

/**
 * Pure comparison, exported for unit testing without a live DB. Compares BOTH
 * database name and server host, and both EXACTLY — same rule and same reason
 * as apply-receipt-intake.mjs: a guard that accepts a substring gets looser the
 * shorter the operator's input is.
 *
 * This is the EXACT case only, and it stays synchronous on purpose. When the
 * operator names a HOST rather than an address, the identity check calls
 * `targetHostMatches`, which resolves it — see there for why.
 */
export function targetMatches(actual, expectDb, expectHost) {
    if (!targetDbMatches(actual, expectDb)) return false;
    return String(actual.host ?? "") === String(expectHost ?? "");
}

/**
 * THE WHOLE IDENTITY CHECK, in one call, so two scripts cannot check different
 * things.
 *
 * Asks the SERVER what it is (`current_database()`, `inet_server_addr()`),
 * compares the database name exactly and the ADDRESS against the names the
 * operator meant (see `targetHostMatches`), and — for a target that demands
 * it — proves the production baseline migration is applied here.
 * Returns the banner to print rather than printing it, so the caller decides
 * where its output goes and a test can read the string.
 *
 * `prisma` is any client with `$queryRawUnsafe`; the backfill passes its own.
 */
export async function verifyTargetIdentity(prisma, { target, url, from, expectDb, expectHost, resolve }) {
    const [actual] = await prisma.$queryRawUnsafe(
        `SELECT current_database() AS db, COALESCE(host(inet_server_addr()), '') AS host`,
    );
    const banner = targetBanner(target, { url, from, db: actual?.db, host: actual?.host });
    const notes = [];
    const reported = String(actual?.host ?? "") || "(none — Unix socket)";
    const refuse = detail => ({
        ok: false,
        banner,
        notes: [],
        error:
            `REFUSING: expected db="${expectDb}" host="${expectHost}" but connected to ` +
            `db="${actual?.db}" host="${actual?.host}".` + (detail ? ` ${detail}` : ""),
    });
    // The database NAME is still compared exactly.
    if (!targetDbMatches(actual, expectDb)) return refuse();
    // Behind the pooler it is the PROJECT'S database that answers, and its
    // address is published under db.<ref>.supabase.co rather than under the
    // pooler name. The ref is the one projectRefVerdict already matched against
    // APPLY_EXPECT_PROJECT_REF, so this narrows the question rather than widening it.
    const directHost = directDbHostForUrl(url);
    const dialled = urlHostname(url);
    let how;
    try {
        how = await targetHostMatches(actual?.host, expectHost, resolve, dialled, directHost);
    } catch (error) {
        const names = directHost ? `"${expectHost}" / "${directHost}"` : `"${expectHost}"`;
        return refuse(
            `${names} could not be resolved (${error?.message ?? error}), so the connected address ` +
            `"${reported}" cannot be checked against it.`,
        );
    }
    if (!how) {
        return refuse(
            directHost
                ? `That address is not "${expectHost}" or "${directHost}", and neither name resolves to it.`
                : `That address is not "${expectHost}", and that name does not resolve to it.`,
        );
    }
    notes.push(
        `host check: ${how} — --expect-host "${expectHost}" vs the address the server reported ("${reported}")`
        + (how === "project-db" ? `; behind the pooler the project's own database answers, so "${directHost}" was resolved too` : "")
        + (how === "unix-socket" ? `; no address to compare, so the URL's own hostname "${dialled}" was used` : ""),
    );
    if (APPLY_TARGETS[target]?.requireBaseline) {
        const baseline = await prisma.$queryRawUnsafe(
            `SELECT 1 AS present FROM "_prisma_migrations"
              WHERE migration_name = $1 AND finished_at IS NOT NULL`,
            PRODUCTION_BASELINE_MIGRATION,
        );
        if (!baseline?.length) {
            return {
                ok: false,
                banner,
                notes: [],
                error:
                    `REFUSING: this database has no applied ${PRODUCTION_BASELINE_MIGRATION} row, ` +
                    `so it is not the baselined production database.`,
            };
        }
        notes.push(`verified baseline ${PRODUCTION_BASELINE_MIGRATION} is applied here`);
    }
    return { ok: true, banner, notes };
}

/**
 * Everything a caller must do BEFORE it constructs a client: name the target,
 * resolve the URL the way that target allows, and check the host and project
 * ref that are readable from the URL alone. Returns `{ error }` or
 * `{ target, url, from }`.
 */
export function resolveTargetOrRefuse(argv, env = process.env, io = {}) {
    const chosen = parseTarget(argv);
    if (chosen.error) return { error: chosen.error };
    // `io` exists so a test can drive this WHOLE chain against the exact
    // production URL shape without a .env.production.local on disk. The
    // composite is what a caller uses, so the composite is what has to be
    // tested: the pieces can each be right while the wiring drops one.
    const resolved = resolveTargetDatabaseUrl(chosen.name, { env, ...io });
    if (resolved.error) return { error: resolved.error };
    const hostProblem = targetHostVerdict(chosen.name, resolved.url);
    if (hostProblem) return { error: hostProblem };
    const refProblem = projectRefVerdict(chosen.name, resolved.url, env);
    if (refProblem) return { error: refProblem.replace(/^REFUSING: /, "") };
    return { target: chosen.name, url: resolved.url, from: resolved.from };
}
