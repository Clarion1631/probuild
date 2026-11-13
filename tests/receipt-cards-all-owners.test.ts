import test, { before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { OwnerCard } from "../src/lib/receipt-request-cards";

/**
 * Every owner gets their morning card, not only the first one in line.
 *
 * THE STORY. The weekday cron posts one "Receipts needed" Chat card per owner
 * (CJ, then Richard) inside ONE invocation with a wall clock. One morning the
 * run spent about 42 s before CJ's card went out and finished CJ at about
 * 48 s; Richard's turn then had under the 14 s send headroom left of the 55 s
 * wall, so he was deferred and got nothing. The only same-day retry was two
 * hours later. These tests pin the fix: a longer run wall for the first pass,
 * plus extra same-morning retry passes that never double-message anyone.
 *
 * Harness: the cards half of tests/receipt-round35-fixes.test.ts, driven
 * through FRESH selection (the real claimOwnerDay) like
 * tests/receipt-cards-complete-scan.test.ts, with a simulated clock.
 */

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.RECEIPT_REQUEST_CARDS_ENABLED = "true";
process.env.RECEIPTS_CHAT_WEBHOOK = "https://chat.googleapis.com/v1/spaces/TESTSPACE/messages?key=x";
delete process.env.RECEIPT_SOURCE_RECOGNITION_ENABLED;

let settings: Map<string, string>;

const settingStore = {
    findUnique: async ({ where }: { where: { key: string } }) =>
        (settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null),
    upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
        settings.set(where.key, settings.has(where.key) ? update.value : create.value);
        return { key: where.key };
    },
    update: async ({ where, data }: { where: { key: string }; data: { value: string } }) => {
        if (!settings.has(where.key)) throw new Error("record not found");
        settings.set(where.key, data.value);
        return { key: where.key };
    },
};

interface ScanRow {
    id: string;
    targetKey: string;
    reasonCodes: string;
    acknowledgedCodes: string;
    displayDetails: string | null;
}

function cardMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    if (typeof where.id === "string" && row.id !== where.id) return false;
    if (typeof where.claimToken === "string" && row.claimToken !== where.claimToken) return false;
    if ("postedAt" in where && where.postedAt === null && row.postedAt !== null) return false;
    if (typeof where.status === "string" && row.status !== where.status) return false;
    const status = where.status as { in?: string[] } | undefined;
    if (status && typeof status === "object" && Array.isArray(status.in) && !status.in.includes(row.status as string)) return false;
    const or = where.OR as Array<Record<string, unknown>> | undefined;
    if (or) {
        const free = row.claimedAt === null
            || or.some(clause => {
                const claimed = clause.claimedAt as { lt?: Date } | null | undefined;
                return claimed?.lt instanceof Date
                    && row.claimedAt instanceof Date
                    && row.claimedAt.getTime() < claimed.lt.getTime();
            });
        if (!free) return false;
    }
    return true;
}

// ── Fixture state, cleared by reset() before every test ─────────────────────

let queue: ScanRow[];
let byId: Map<string, ScanRow>;
let cards: Map<string, Record<string, unknown>>;
/** The immutable one-message-per-owner-per-day reservations, as rows. */
let deliveries: Array<{ owner: string; deliveryDay: string; cardId: string }>;
let postCalls: Array<{ owner: string; timeoutMs?: number }>;
let errorCalls: unknown[][];
let offsetMs: number;
/** The simulated clock's cost model for the run in flight. */
let cost = { scanMs: 20_000, recheckMs: 20_000, postMs: 3_000 };

function row(id: string, owner: string): ScanRow {
    const r: ScanRow = {
        id, targetKey: `bl-${id}`, reasonCodes: '["MISSING_RECEIPT"]', acknowledgedCodes: "[]",
        displayDetails: JSON.stringify({
            amountCents: -4000, owner, postedDate: "2026-01-05", payee: "SUPPLY CO", fingerprint: `pb-${id}`,
        }),
    };
    byId.set(id, r);
    return r;
}

function seedCertified(): void {
    const today = new Date().toISOString().slice(0, 10);
    settings.set("receiptRequestsCycle", JSON.stringify({
        id: "cycle-test", epoch: "1", evidenceEpoch: "1",
        recognitionPolicy: "receipt-source-v1:off", plannerDay: today,
    }));
    settings.set("receiptRequestsPhase", JSON.stringify({
        phase: "done", chaserCompletedAt: new Date().toISOString(),
        completedCycleId: "cycle-test", blockedReason: null,
    }));
}

/** Both owners have open charges, never asked before. */
function seedBothOwners(): void {
    queue = [row("ri-cj-1", "CJ"), row("ri-rich-1", "Richard")];
}

function reset(): void {
    queue = [];
    byId = new Map();
    cards = new Map();
    deliveries = [];
    postCalls = [];
    errorCalls = [];
    settings = new Map();
    offsetMs = 0;
    cost = { scanMs: 20_000, recheckMs: 20_000, postMs: 3_000 };
}

const sqlText = (first: unknown): string => Array.isArray(first)
    ? (first as readonly string[]).join("?")
    : ((first as { strings?: readonly string[] }).strings ?? []).join("?");

const cardsPrisma: Record<string, unknown> = {
    $queryRaw: async (first: unknown) => {
        const text = sqlText(first);
        if (text.includes("pg_try_advisory_xact_lock")) return [{ locked: true }];
        if (text.includes("ReceiptRequestCard")) return [];
        if (text.includes("AutomationSetting")) return [{ value: "1" }];
        return [];
    },
    $executeRaw: async () => 0,
    receiptRequestCardDelivery: {
        findMany: async ({ where }: { where?: { deliveryDay?: string } } = {}) =>
            deliveries.filter(d => !where?.deliveryDay || d.deliveryDay === where.deliveryDay).map(d => ({ owner: d.owner })),
        create: async ({ data }: { data: { owner: string; deliveryDay: string; cardId: string } }) => {
            // The real table has a unique (owner, deliveryDay) index.
            if (deliveries.some(d => d.owner === data.owner && d.deliveryDay === data.deliveryDay)) {
                throw Object.assign(new Error("unique"), { code: "P2002" });
            }
            deliveries.push(data);
            return { id: `del-${deliveries.length}`, ...data };
        },
        deleteMany: async () => ({ count: 0 }),
    },
    $transaction: async (arg: unknown) =>
        (typeof arg === "function" ? await (arg as (tx: unknown) => Promise<unknown>)(cardsPrisma) : arg),
    automationSetting: settingStore,
    receiptMemoArtifact: { findMany: async () => [] },
    reviewIssue: {
        findMany: async (args: {
            where: { id?: { in: string[] } };
            take?: number;
            cursor?: { id: string };
            skip?: number;
        }) => {
            // The pre-send re-check (`loadCardItemTruth`) asks by id: one call
            // per card, so it carries the per-card re-check cost.
            if (args.where.id?.in) {
                offsetMs += cost.recheckMs;
                const wanted = new Set(args.where.id.in);
                return [...byId.values()].filter(r => wanted.has(r.id)).map(r => ({ ...r, clearedAt: null }));
            }
            // The candidate scan: the up-front cost before the send loop.
            const at = args.cursor ? queue.findIndex(r => r.id === args.cursor!.id) : -1;
            const from = args.cursor ? at + (args.skip ?? 0) : 0;
            if (args.cursor && at < 0) return [];
            const page = queue.slice(Math.max(from, 0), Math.max(from, 0) + (args.take ?? queue.length));
            offsetMs += cost.scanMs;
            return page;
        },
    },
    receiptRequestCard: {
        findUnique: async ({ where }: { where: { owner_pacificDate: { owner: string; pacificDate: string } } }) =>
            cards.get(`${where.owner_pacificDate.owner}|${where.owner_pacificDate.pacificDate}`) ?? null,
        findMany: async () => [],
        create: async ({ data }: { data: Record<string, unknown> }) => {
            const key = `${data.owner as string}|${data.pacificDate as string}`;
            const r = { id: `card-${cards.size + 1}`, status: "PENDING", postedAt: null, ...data };
            cards.set(key, r);
            return r;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            let count = 0;
            for (const r of cards.values()) {
                if (!cardMatches(r, where)) continue;
                for (const [key, value] of Object.entries(data)) {
                    if (value && typeof value === "object" && "increment" in (value as object)) {
                        r[key] = ((r[key] as number) ?? 0) + (value as { increment: number }).increment;
                    } else {
                        r[key] = value;
                    }
                }
                count++;
            }
            return { count };
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
            let count = 0;
            for (const [key, r] of [...cards.entries()]) {
                if (!cardMatches(r, where)) continue;
                cards.delete(key);
                count++;
            }
            return { count };
        },
    },
};

let cardsGET: (request: Request) => Promise<Response>;

before(async () => {
    const originalRequire = Module.prototype.require;
    const patch = (resolve: (id: string) => unknown) => {
        (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
            this: NodeModule,
            id: string,
        ) {
            const hit = resolve(id);
            if (hit !== undefined) return hit;
            // eslint-disable-next-line prefer-rest-params
            return originalRequire.apply(this, arguments as unknown as [string]);
        } as typeof Module.prototype.require;
    };

    const realCards = await import("../src/lib/receipt-request-cards");
    patch(id => {
        if (id === "@/lib/prisma") return { prisma: cardsPrisma };
        if (id === "@/lib/cron-auth") return { isCronAuthorized: () => true };
        if (id === "@/lib/receipt-card-history") {
            return { recordCardOnIssues: async () => undefined, itemsMissingCardRecord: async () => [] };
        }
        if (id === "@/app/api/cron/receipt-requests/route") return { recomputeCodesFor: async () => ["MISSING_RECEIPT"] };
        if (id === "@/lib/receipt-request-cards") {
            return {
                ...realCards,
                isPacificWeekday: () => true,
                // Each Chat post costs `cost.postMs` of the simulated clock.
                postOwnerCard: async (_url: string, card: OwnerCard, options: { timeoutMs?: number } = {}) => {
                    postCalls.push({ owner: card.owner, timeoutMs: options.timeoutMs });
                    offsetMs += cost.postMs;
                    return { kind: "delivered", owner: card.owner, threadName: "spaces/TESTSPACE/threads/t", messageName: "spaces/TESTSPACE/messages/m" };
                },
            };
        }
        return undefined;
    });
    let cardsMod: { GET?: unknown };
    try {
        cardsMod = await import("../src/app/api/cron/receipt-request-cards/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof cardsMod.GET !== "function") throw new Error("the receipt-request-cards cron did not load");
    cardsGET = cardsMod.GET as typeof cardsGET;
});

/** One invocation on a fresh simulated clock (base = now, offset = 0). */
async function runGET(query: string, costs: typeof cost): Promise<Record<string, unknown>> {
    cost = costs;
    const realNow = Date.now;
    const base = realNow();
    offsetMs = 0;
    Date.now = () => base + offsetMs;
    const realError = console.error;
    console.error = (...args: unknown[]) => { errorCalls.push(args); };
    try {
        const res = await cardsGET(new Request(`https://probuild.test/api/cron/receipt-request-cards${query}`));
        return await res.json() as Record<string, unknown>;
    } finally {
        Date.now = realNow;
        console.error = realError;
    }
}

const todayPacific = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const FAST = { scanMs: 1_000, recheckMs: 1_000, postMs: 1_000 };
const OWNERS_TODAY = ["CJ", "Richard"];
const owners = (list: unknown) => (list as Array<{ owner: string }>).map(entry => entry.owner);

// ── Tests ───────────────────────────────────────────────────────────────────

test("the morning run messages every owner, not only the first", async () => {
    // Real failure: the run spent ~20 s before CJ's turn, ~20 s re-checking
    // his card and 3 s posting it, so Richard's turn began at ~43 s of a 55 s
    // wall with 12 s left (under the 14 s headroom). He was deferred and got
    // no card until the 16:30Z retry, two hours later.
    reset();
    seedCertified();
    seedBothOwners();

    const summary = await runGET("", { scanMs: 20_000, recheckMs: 20_000, postMs: 3_000 });

    assert.deepEqual(postCalls.map(c => c.owner), OWNERS_TODAY, "both owners were messaged, CJ then Richard");
    assert.deepEqual(summary.sendDeferredOwners, [], "nobody was deferred for time");
    assert.deepEqual(owners(summary.posted), OWNERS_TODAY);
    for (const owner of OWNERS_TODAY) {
        assert.equal(cards.get(`${owner}|${todayPacific()}`)?.status, "POSTED", `${owner}'s card row ends POSTED`);
    }
});

test("a person the first pass had no time for gets their card on the next same-day pass, and nobody is messaged twice", async () => {
    // Real failure shape: when pass one is too slow to reach everyone, the
    // next same-morning pass must send exactly the person it missed. It must
    // not re-message whoever pass one already reached.
    //
    // Pass one's re-check costs 60 s per card. CJ's turn starts at 20 s, his
    // re-check ends at 80 s (inside the 105 s re-check budget) and his card
    // posts at 83 s. Richard's turn starts with 32 s left, but his re-check
    // would end at 143 s, past the budget, so his card is held back whole.
    reset();
    seedCertified();
    seedBothOwners();

    const first = await runGET("", { scanMs: 20_000, recheckMs: 60_000, postMs: 3_000 });
    assert.deepEqual(postCalls.map(c => c.owner), ["CJ"], "pass one reached CJ only");
    assert.deepEqual(first.sendDeferredOwners, ["Richard"], "and says it did not reach Richard");
    const richardRow = cards.get(`Richard|${todayPacific()}`);
    assert.equal(richardRow?.status, "PENDING", "Richard's card is kept, unsent");
    assert.equal(richardRow?.claimedAt, null, "with its claim released for the next pass");

    const second = await runGET("?retry=1&pass=2", FAST);

    assert.deepEqual(owners(second.posted), ["Richard"], "pass two sends exactly the person pass one missed");
    assert.deepEqual(postCalls.map(c => c.owner), ["CJ", "Richard"], "one message each across both passes, CJ never twice");
    assert.deepEqual(second.sendDeferredOwners, [], "pass two deferred nobody");
    assert.equal(cards.get(`Richard|${todayPacific()}`)?.status, "POSTED");
});

test("vercel.json runs a same-morning retry pass soon after the first pass", () => {
    // Real failure: the only same-day retry was at 16:30Z, two hours after the
    // 14:30Z first pass, so a deferred owner waited all morning.
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const config = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    const base = "/api/cron/receipt-request-cards";
    const crons = config.crons;

    const firstPass = crons.find(c => c.path === base);
    assert.ok(firstPass, "the first pass is still scheduled");
    assert.equal(firstPass!.schedule, "30 14 * * 1-5");

    const retries = crons.filter(c => c.path.startsWith(`${base}?retry=1`));
    const soon = retries.filter(c => {
        const [minute, hour, dom, month, dow] = c.schedule.split(/\s+/);
        const m = Number(minute);
        return hour === "14" && dom === "*" && month === "*" && dow === "1-5"
            && Number.isInteger(m) && m >= 33 && m <= 59;
    });
    assert.ok(soon.length >= 1, `a weekday retry at 14:33-14:59Z exists (retries: ${JSON.stringify(retries)})`);
    // The two passes as shipped. The guide tells the office "about 4 and 12
    // minutes later", so a change here must change the guide too.
    const at = (path: string) => crons.find(c => c.path === path)?.schedule;
    assert.equal(at(`${base}?retry=1&pass=2`), "34 14 * * 1-5");
    assert.equal(at(`${base}?retry=1&pass=3`), "42 14 * * 1-5");

    assert.ok(
        retries.some(c => c.schedule === "30 16 * * 1-5"),
        "the 16:30Z retry still exists",
    );

    const paths = crons.map(c => c.path);
    assert.equal(new Set(paths).size, paths.length, "no two cron entries share a path");
});

test("a third pass on the same day sends nothing new once everyone has their card", async () => {
    // Guard: the extra passes must be harmless. With both cards POSTED and
    // both delivery records written, a later pass is silent.
    reset();
    seedCertified();
    seedBothOwners();

    // A quick morning, so this guard holds on today's 55 s wall as well as
    // the longer one: it is about the third pass, not about the wall.
    await runGET("", FAST);
    for (const owner of OWNERS_TODAY) {
        assert.equal(cards.get(`${owner}|${todayPacific()}`)?.status, "POSTED", `precondition: ${owner} is POSTED`);
        assert.ok(deliveries.some(d => d.owner === owner && d.deliveryDay === todayPacific()), `precondition: ${owner} has a delivery record`);
    }
    postCalls = [];

    const third = await runGET("?retry=1&pass=3", FAST);

    assert.deepEqual(postCalls, [], "nothing was posted by the third pass");
    assert.deepEqual(third.posted, []);
});

test("a scan that takes most of a minute still claims nobody and says so", async () => {
    // Guard for the longer wall: the candidate scan keeps its own 45 s limit.
    // On the 105 s re-check clock a 50-second first page would be allowed a
    // second one, the read would finish at 100 s, both owners would be claimed
    // and then held back for want of time, and the run would report ok. A
    // scan that slow has to stop, claim nothing, and fail the heartbeat.
    reset();
    seedCertified();
    // 2 + 500 rows: the first page (500) comes back full, so the scan wants a
    // second page.
    queue = [row("ri-cj-1", "CJ"), row("ri-rich-1", "Richard"), ...Array.from({ length: 500 }, (_, i) => row(`ri-office-${String(i).padStart(3, "0")}`, "office"))];

    const summary = await runGET("", { scanMs: 50_000, recheckMs: 1_000, postMs: 1_000 });

    assert.equal(summary.scanDeadlineHit, true, "the scan stopped on its own clock");
    assert.equal(summary.scanIncomplete, true);
    assert.equal(summary.claimed, 0, "nobody's day was claimed from a partial read");
    assert.deepEqual(postCalls, []);
    assert.equal(summary.ok, false, "and the run says so, which fails the heartbeat");
});
