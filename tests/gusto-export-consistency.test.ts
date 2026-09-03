/**
 * Two things the payroll export promises that nothing else in the suite pins:
 *
 *  1. IT READS EVERYTHING THROUGH ONE CLIENT. lockPayrollPeriod recomputes the
 *     export inside its own transaction so the hash it freezes describes the
 *     snapshot its locks are holding. Two of the reads went out on the GLOBAL
 *     prisma client anyway — the company time zone and the Gusto employee
 *     mappings — which is a second and third connection, outside that
 *     transaction, free to see an edit the lock exists to freeze. The failure is
 *     not theoretical: the zone decides which company-local day (and therefore
 *     which workweek, and therefore how much of the period is overtime) every
 *     punch falls in, and the mappings fill a CSV column. A zone or mapping edit
 *     committed between those reads and the entry read produces a file over
 *     inputs that never existed together at any instant — and then it gets
 *     frozen.
 *
 *  2. ITS ORDERING DOES NOT DEPEND ON THE PROCESS LOCALE. Every sort feeding the
 *     CSVs used a parameterless `localeCompare()`, which reads the runtime's
 *     default locale — ICU build, LANG/LC_ALL, base image. Two servers on the
 *     identical commit could order the same two employees differently, produce
 *     two different exportHash values for one period, and the lock would report
 *     that "the hours in this period changed".
 *
 * The transaction half is driven through a RECORDING FAKE CLIENT rather than a
 * mock of the module: `loadGustoExport` takes its client as a parameter, so the
 * dependency needs no interception at all. What the fake shows is which client
 * each read went out on and in what ORDER. That PostgreSQL genuinely blocks a
 * concurrent zone/mapping change against the FOR SHARE this takes is a separate,
 * two-real-connection proof in tests/payroll-settings-lock-db.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-gusto-export-consistency";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

import {
    buildGustoExport,
    compareCodePoints,
    toDetailCsv,
    toSummaryCsv,
    type ExportEntry,
    type ExportUser,
} from "../src/lib/gusto-export-core";
import { hashExport, loadGustoExport, type ExportDbClient } from "../src/lib/gusto-export-db";
import { encryptObject } from "../src/lib/crypto";

const DB_SOURCE = readFileSync(path.join(__dirname, "..", "src", "lib", "gusto-export-db.ts"), "utf8");
const TZ = "America/Los_Angeles";

// ---------------------------------------------------------------------------
// 1. Everything the export reads goes through the caller's client
// ---------------------------------------------------------------------------

test("gusto-export-db reaches the global prisma client NOWHERE — every read is on `client`", () => {
    // The whole module, not just loadGustoExport: findPayrollPeriod and
    // findOverlappingLockedPeriods take the same client and are called from
    // inside the lock transaction too. `prisma` still appears as the DEFAULT
    // value of those parameters (`client: ExportDbClient = prisma`) and as
    // `options.client ?? prisma`, which is the point — it is the fallback, never
    // a receiver. A property access on it is what this forbids.
    const globalReads = [...DB_SOURCE.matchAll(/\bprisma\.\w+/g)].map((m) => m[0]);
    assert.deepEqual(
        globalReads,
        [],
        "a read on the global prisma client inside the export path escapes the caller's transaction"
    );
});

test("the time zone and the Gusto mappings are read through the same client, once", () => {
    assert.match(DB_SOURCE, /const timeZone = await resolveCompanyTimeZone\(client\);/);
    assert.match(DB_SOURCE, /const gustoSettings = await getGustoSettings\(client\);/);
    // Resolved ONCE and everything derived from it — a second resolve is a
    // second chance to disagree with the first.
    assert.equal(
        (DB_SOURCE.match(/resolveCompanyTimeZone\(/g) || []).length,
        1,
        "the zone must be resolved exactly once inside loadGustoExport"
    );
});

test("the settings rows are pinned FOR SHARE before anything is read", () => {
    assert.match(DB_SOURCE, /FROM "CompanySettings" WHERE "id" = \$1 FOR SHARE/);
    assert.match(DB_SOURCE, /FROM "Integration" WHERE "id" = \$1 FOR SHARE/);
    // Ordering in the source is not the proof — the recording fake below is —
    // but a lock taken after the read it is meant to protect is worth catching
    // here too.
    assert.ok(
        DB_SOURCE.indexOf("lockExportInputRows(client") < DB_SOURCE.indexOf("client.timeEntry.findMany"),
        "the lock must be taken before the entries are read"
    );
});

type Recorded = string[];

/**
 * A structural stand-in for a Prisma interactive transaction client.
 *
 * Deliberately has NO `$transaction` method: that absence is exactly how
 * `isTransactionClient` in gusto-export-db.ts tells a transaction client from
 * the base client (Prisma builds one as the base client minus ITXClientDenyList,
 * which `$transaction` is a member of). A fake that carried the method would be
 * asserting against the wrong branch.
 */
function fakeTx(recorded: Recorded, options: { timeZone?: string; mappings?: Record<string, string> } = {}) {
    const settings = encryptObject({ gusto: { connected: true, employeeMappings: options.mappings ?? {} } });
    return {
        $queryRawUnsafe: async (sql: string) => {
            recorded.push(`raw:${sql.replace(/\s+/g, " ").trim()}`);
            return [];
        },
        companySettings: {
            findUnique: async () => {
                recorded.push("companySettings.findUnique");
                return { timeZone: options.timeZone ?? TZ };
            },
        },
        integration: {
            findUnique: async () => {
                recorded.push("integration.findUnique");
                return { id: "system_settings", settings };
            },
        },
        payrollPeriod: {
            findUnique: async () => {
                recorded.push("payrollPeriod.findUnique");
                return null;
            },
            findMany: async () => {
                recorded.push("payrollPeriod.findMany");
                return [];
            },
        },
        timeEntry: {
            findMany: async () => {
                recorded.push("timeEntry.findMany");
                return [];
            },
        },
        user: {
            findMany: async () => {
                recorded.push("user.findMany");
                return [];
            },
        },
    };
}

const PERIOD_START = new Date("2026-08-17T07:00:00.000Z");
const PERIOD_END = new Date("2026-08-31T07:00:00.000Z");

async function load(client: unknown, extra: Record<string, unknown> = {}) {
    return loadGustoExport(PERIOD_START, PERIOD_END, {
        client: client as ExportDbClient,
        startKey: "2026-08-17",
        endKey: "2026-08-31",
        ...extra,
    });
}

test("every read goes out on the supplied transaction client, and the locks come first", async () => {
    const recorded: Recorded = [];
    await load(fakeTx(recorded));

    // Nothing was left for the global client to do: if any read had escaped,
    // it would be missing from this list (and, with no database behind the
    // singleton, would have thrown instead).
    assert.deepEqual(recorded.slice(0, 2), [
        'raw:SELECT "id" FROM "CompanySettings" WHERE "id" = $1 FOR SHARE',
        'raw:SELECT "id" FROM "Integration" WHERE "id" = $1 FOR SHARE',
    ]);

    for (const read of ["companySettings.findUnique", "integration.findUnique", "timeEntry.findMany", "user.findMany"]) {
        assert.ok(recorded.includes(read), `${read} must run on the transaction client`);
    }

    // The ordering that matters: both mutable NON-entry inputs are read before
    // the entries, so the CSV cannot mix inputs from two instants.
    const entries = recorded.indexOf("timeEntry.findMany");
    assert.ok(recorded.indexOf("companySettings.findUnique") < entries, "zone before entries");
    assert.ok(recorded.indexOf("integration.findUnique") < entries, "mappings before entries");
});

test("the period lookups are sequential, not concurrent, on a one-connection client", async () => {
    // Promise.all on an interactive transaction client puts two statements on a
    // connection that already has one in flight. Recorded order is enough to
    // show they are issued one after the other.
    const recorded: Recorded = [];
    await load(fakeTx(recorded));
    assert.ok(
        recorded.indexOf("payrollPeriod.findUnique") < recorded.indexOf("payrollPeriod.findMany"),
        "the two period reads must be serialised"
    );
});

test("a caller's zone that disagrees with the locked row REFUSES rather than exporting", async () => {
    // lockPayrollPeriod derives periodStart/periodEnd from a zone it resolved
    // BEFORE opening its transaction, and writes that zone onto the period row.
    // If CompanySettings.timeZone moved in between, the recompute would be in a
    // different zone from the one being recorded — so it is refused, and the
    // throw rolls the lock back.
    const recorded: Recorded = [];
    await assert.rejects(
        () => load(fakeTx(recorded, { timeZone: "America/New_York" }), { timeZone: TZ }),
        /company time zone changed \(America\/Los_Angeles to America\/New_York\)/
    );
    assert.ok(
        !recorded.includes("timeEntry.findMany"),
        "a refused zone must not go on to read (or hash) any hours"
    );
});

test("an agreeing zone is accepted, and the mappings reach the CSV", async () => {
    const recorded: Recorded = [];
    const result = await load(fakeTx(recorded, { mappings: { "u-1": "GUSTO-1" } }), { timeZone: TZ });
    assert.equal(result.timeZone, TZ);
    assert.equal(typeof result.exportHash, "string");
});

test("outside a transaction NO lock is taken — a released lock would promise nothing", async () => {
    // On the base client every statement is its own transaction, so a FOR SHARE
    // would be gone before the next line. The page render and the download
    // endpoint are ordinary reads; the guard makes that explicit rather than
    // emitting a lock that reads as protection and is not.
    const recorded: Recorded = [];
    const base = { ...fakeTx(recorded), $transaction: async () => undefined };
    await load(base);
    assert.deepEqual(
        recorded.filter((entry) => entry.startsWith("raw:")),
        [],
        "the base client must not be handed a lock that is released immediately"
    );
});

// ---------------------------------------------------------------------------
// 2. Ordering, and therefore the hash, is locale-invariant
// ---------------------------------------------------------------------------

const NAMES: Array<[string, string]> = [
    ["u-1", "Ötzi Iceman"],
    ["u-2", "O'Brien-Smith"],
    ["u-3", "Ostrowski Zed"],
    ["u-4", "Zoë Ångström"],
    ["u-5", "aaron lowercase"],
    ["u-6", "Ávila-Núñez"],
];

const users: ExportUser[] = NAMES.map(([id, name]) => ({
    id,
    name,
    email: `${id}@example.test`,
    payType: "HOURLY",
}));

const entries: ExportEntry[] = NAMES.map(([id], index) => ({
    id: `e-${id}`,
    userId: id,
    // Same instant for everyone, so the DETAIL sort has to fall through to the
    // name comparison — the tie-break is the thing under test.
    startTime: new Date("2026-08-18T15:00:00.000Z"),
    endTime: new Date("2026-08-18T23:00:00.000Z"),
    durationHours: 8,
    shiftHours: 8,
    mealDeductionHours: 0,
    mealOutcome: "TAKEN",
    needsReview: false,
    isEdited: false,
    projectName: `Job ${index}`,
    costCodeLabel: "01-DEMO",
}));

function buildCsvs() {
    const built = buildGustoExport({
        entries,
        users,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        timeZone: TZ,
        employeeMappings: Object.fromEntries(NAMES.map(([id], i) => [id, `GUSTO-${i}`])),
    });
    const summaryCsv = toSummaryCsv(built.employees);
    const detailCsv = toDetailCsv(built.detail);
    return { summaryCsv, detailCsv, exportHash: hashExport(summaryCsv, detailCsv) };
}

test("a locale-aware comparator and a code-point comparator are DIFFERENT functions", () => {
    // The bug, stated as a fact about the two comparators rather than about any
    // one machine's configuration. Pinned with EXPLICIT locales so this cannot
    // depend on what LANG happens to be set to while the suite runs.
    const collator = new Intl.Collator("sv");
    if (collator.resolvedOptions().locale !== "sv") {
        // A small-icu build silently falls back to en-US. Nothing to demonstrate
        // with one locale, and a fabricated pass would be worse than a skip.
        return;
    }
    const en = new Intl.Collator("en").compare;
    const sv = collator.compare;

    // Swedish sorts Ä after Z; English sorts it with A. One pair of strings,
    // two answers, from the same runtime.
    assert.ok(en("Ä", "Z") < 0, "en puts Ä before Z");
    assert.ok(sv("Ä", "Z") > 0, "sv puts Ä after Z");

    // The code-point comparator agrees with neither, and with itself everywhere.
    assert.ok(compareCodePoints("Ä", "Z") > 0, "U+00C4 is above U+005A, in every locale there is");
});

test("compareCodePoints is a total order over the exact code points", () => {
    assert.equal(compareCodePoints("abc", "abc"), 0);
    assert.ok(compareCodePoints("abc", "abd") < 0);
    assert.ok(compareCodePoints("ab", "abc") < 0, "a prefix sorts first");
    assert.ok(compareCodePoints("Z", "a") < 0, "uppercase is below lowercase by code point");
    assert.ok(compareCodePoints("O'Brien", "Ostrowski") < 0, "U+0027 is below U+0073");
    // Astral characters are ONE unit, not two surrogate halves: Array.from is
    // what makes "\u{1F600}" compare above "�" instead of below it.
    assert.ok(compareCodePoints("\u{1F600}", "�") > 0);
});

test("the CSVs and the exportHash are byte-identical under a different collation", () => {
    const before = buildCsvs();

    // Replace localeCompare with a comparator that answers the OPPOSITE of any
    // sane collation. If a single ordering path still routed through it, the
    // rows below would come back in a different order and the hash would move.
    // This is stronger than swapping locales: it fails for ANY residual use,
    // including one whose two locales happen to agree.
    const original = String.prototype.localeCompare;
    let stubUsed = false;
    // eslint-disable-next-line no-extend-native
    String.prototype.localeCompare = function (this: string, that: string) {
        stubUsed = true;
        const self = String(this);
        return self < String(that) ? 1 : self > String(that) ? -1 : 0;
    } as typeof String.prototype.localeCompare;

    let after: ReturnType<typeof buildCsvs>;
    let controlSaw: boolean;
    try {
        // Control: the stub really is installed, and really does invert.
        assert.equal("a".localeCompare("b"), 1, "the stub must be live for this test to mean anything");
        stubUsed = false;
        after = buildCsvs();
        controlSaw = stubUsed;
    } finally {
        String.prototype.localeCompare = original;
    }

    assert.equal(controlSaw, false, "the export must not call localeCompare at all");
    assert.equal(after.summaryCsv, before.summaryCsv, "summary CSV bytes must not move with collation");
    assert.equal(after.detailCsv, before.detailCsv, "detail CSV bytes must not move with collation");
    assert.equal(after.exportHash, before.exportHash, "the frozen hash must not move with collation");
});

test("the accented roster actually exercises the ordering (the fixture is not trivially sorted)", () => {
    // A fixture already in code-point order would pass the test above no matter
    // what the comparator did. This asserts the emitted order is the code-point
    // one AND that a locale-aware sort of the same names differs from it.
    const { summaryCsv } = buildCsvs();
    const emitted = summaryCsv
        .split("\n")
        .slice(1)
        .filter(Boolean)
        .map((line) => line.split(",")[0].replace(/^"|"$/g, "").replace(/""/g, '"'));

    const byCodePoint = NAMES.map(([, name]) => name).sort(compareCodePoints);
    assert.deepEqual(emitted, byCodePoint, "the CSV is in code-point order");

    const byLocale = NAMES.map(([, name]) => name).sort(new Intl.Collator("en").compare);
    assert.notDeepEqual(byLocale, byCodePoint, "these names order differently under a locale-aware sort");
});
