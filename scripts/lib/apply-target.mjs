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
 * THE CONNECTED ADDRESS, IN A FORM THAT CAN BE COMPARED.
 *
 * `host(inet_server_addr())` answers with an ADDRESS. A dual-stack socket that
 * reached an IPv4 server can report it in the IPv4-mapped spelling
 * (`::ffff:10.0.0.5`), which is the same machine as `10.0.0.5` and must not
 * read as a different one.
 */
export function normalizeServerAddress(address) {
    const value = String(address ?? "").trim();
    const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(value);
    return (mapped ? mapped[1] : value).toLowerCase();
}

/**
 * Loopback is answered WITHOUT a lookup: `localhost` is how the throwaway CI
 * container is dialled, and resolving it would make the guard depend on
 * whatever /etc/hosts happens to say on the runner.
 */
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"];

/** The default resolver: real DNS, asked for EVERY address of the name. */
function lookupAddresses(hostname) {
    return dns.promises.lookup(hostname, { all: true });
}

/** The URL's own hostname, or null if it is not a URL. */
function hostnameFromUrl(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

/**
 * DOES THE SERVER WE ARE CONNECTED TO ANSWER TO THE NAME THE OPERATOR TYPED?
 *
 * The comment above `targetHostVerdict` has always said the identity cannot
 * rest on `inet_server_addr()`, because that is an ADDRESS while
 * `--expect-host` is a NAME. The check underneath compared the two as strings
 * anyway, so on production — where the pooler answers as an IPv6 literal like
 * `2600:1f13:...` and the operator types `aws-0-us-west-2.pooler.supabase.com`
 * — it could never pass, and it refused every real run (the sibling
 * apply-receipt-intake printed exactly that refusal on 2026-09-04).
 *
 * So the NAME is RESOLVED and the connected address has to be one of the
 * answers. `resolve` is a parameter so tests never touch the network, and a
 * name that cannot be resolved is a REFUSAL: an unanswerable question is not a
 * yes. This does not loosen the identity — the pooler host is shared
 * regionally either way, and the PROJECT REF check above is what tells
 * production from a staging clone. It is untouched.
 */
export async function targetHostMatches(actualHost, expectHost, resolve = lookupAddresses) {
    const actual = String(actualHost ?? "");
    const expected = String(expectHost ?? "").trim();
    // (a) The operator typed the address itself — nothing to resolve.
    if (actual !== "" && actual === expected) return { ok: true, how: "exact", addresses: [] };
    // An empty server address is the unix-socket case, which only the caller
    // can judge (it is the one holding the URL); an empty expectation is never
    // a match, because `lookup("")` answers with loopback on some platforms.
    if (actual === "") return { ok: false, how: "no-address", addresses: [] };
    if (expected === "") return { ok: false, how: "no-expectation", addresses: [] };
    const wanted = normalizeServerAddress(actual);
    if (expected.toLowerCase() === "localhost") {
        return { ok: LOOPBACK_ADDRESSES.includes(wanted), how: "loopback", addresses: [...LOOPBACK_ADDRESSES] };
    }
    let addresses;
    try {
        const answer = await resolve(expected);
        addresses = (Array.isArray(answer) ? answer : [answer])
            .map(entry => (typeof entry === "string" ? entry : entry?.address))
            .filter(Boolean)
            .map(normalizeServerAddress);
    } catch (error) {
        return {
            ok: false,
            how: "unresolvable",
            addresses: [],
            detail: `"${expected}" did not resolve (${error?.message ?? error})`,
        };
    }
    return { ok: addresses.includes(wanted), how: "dns", addresses };
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
 * compares both against what the operator said, and — for a target that
 * demands it — proves the production baseline migration is applied here.
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
    const actualHost = String(actual?.host ?? "");
    if (actualHost === "") {
        // A UNIX-SOCKET connection: `inet_server_addr()` is NULL, so the server
        // has no address to compare. The only thing left that names the machine
        // is the host we dialled, and it has to be the one the operator
        // expected. Recorded in the notes rather than passed silently, because
        // this is the one branch where the server did not corroborate it.
        const urlHost = hostnameFromUrl(url);
        if (!urlHost || urlHost !== String(expectHost ?? "")) {
            return refuse(
                `The server reported no address (a local socket) and the connection URL names ` +
                `${urlHost ? `"${urlHost}"` : "no host"}.`,
            );
        }
        notes.push(`the server reported no address (local socket); accepted because the URL dials ${urlHost}`);
    } else {
        const host = await targetHostMatches(actualHost, expectHost, resolve);
        if (!host.ok) {
            return refuse(
                host.how === "unresolvable"
                    ? `${host.detail}.`
                    : `"${expectHost}" resolves to ${host.addresses?.length ? host.addresses.join(", ") : "no address"}, ` +
                      `which does not include the connected server.`,
            );
        }
        if (host.how !== "exact") {
            notes.push(`verified the connected server ${actualHost} is one of the addresses "${expectHost}" answers to`);
        }
    }
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
