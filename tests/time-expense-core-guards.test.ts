/**
 * Two guards on the manual time-entry core (src/lib/time-expense-core.ts),
 * both from the PR #441 adversarial review.
 *
 * 1. THE $0-RATE POLICY IS NOT OPT-IN. It used to run only when the caller
 *    asked to be priced from stored rates, so the MCP `log_time` tool — which
 *    computed its own costs from an unlocked read of the crew list — booked a
 *    completed, unflagged, $0 entry for an hourly crew member with no rate.
 *    The rule now asks about the RESULT (zeroLaborBlocks), and log_time no
 *    longer names a labor cost at all.
 *
 * 2. THE CHANGE-ORDER TAG RE-VALIDATES UNDER THE ROW LOCKS. Membership,
 *    billing state and change-order eligibility were checked before
 *    withPayrollWrite, and the guarded update named only ids and the billing
 *    columns — so a logistics reroute committing in that window moved an entry
 *    to another job and still had a change order from the old one attached.
 *
 * Predicate and wiring, not a live database round-trip: the behavioural half
 * needs two real connections and lives with the other *-db tests. The wiring
 * assertions below are paired with controls, because a source assertion that
 * matches nothing passes for the wrong reason.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isSalariedOwner, zeroLaborBlocks, zeroRateBlocks } from "../src/lib/pay-rate-guard";
import { isTimeEntryTagConflictError, TimeEntryTagConflictError } from "../src/lib/time-expense-core";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const CORE = "src/lib/time-expense-core.ts";
const MCP = "src/app/api/mcp/[transport]/route.ts";
const LOGISTICS_ROUTE = "src/app/api/time-entries/[id]/logistics/route.ts";
const ACTIONS = "src/lib/actions.ts";

/** The body of `createTimeEntryCore`, from its signature to the next export. */
function createCoreBody(): string {
    const source = read(CORE);
    const start = source.indexOf("export async function createTimeEntryCore");
    assert.ok(start > -1, "createTimeEntryCore moved — this file's assertions are about nothing");
    const rest = source.slice(start);
    const end = rest.indexOf("export type CreateTimeEntryFromStoredRatesInput");
    assert.ok(end > -1, "the slice terminator moved");
    return rest.slice(0, end);
}

/** The body of the `withPayrollWrite` callback inside `tagTimeEntriesToChangeOrderCore`. */
function tagGuardedBody(): string {
    const source = read(CORE);
    const start = source.indexOf("export async function tagTimeEntriesToChangeOrderCore");
    assert.ok(start > -1, "tagTimeEntriesToChangeOrderCore moved");
    const fn = source.slice(start, source.indexOf("export async function tagExpensesToChangeOrderCore"));
    const guarded = fn.slice(fn.indexOf("await withPayrollWrite("));
    assert.ok(guarded.length > 200, "the guarded region is empty — the parser is matching nothing");
    return guarded;
}

// ── 1. the $0-rate policy ────────────────────────────────────────────────────

test("zeroLaborBlocks asks the same question of the RESULT that zeroRateBlocks asks of the rate", () => {
    // Where both apply they must agree, or the two doors into a manual entry
    // give two different answers about the same person.
    const cases = [
        { role: "FIELD_CREW", email: "garrett@example.com", payType: "HOURLY" },
        { role: "MANAGER", email: "someone@example.com", payType: null },
        { role: "ADMIN", email: "boss@example.com", payType: null },
        { role: "FINANCE", email: "books@example.com", payType: null },
        { role: "EMPLOYEE", email: "legacy@example.com", payType: "HOURLY" },
        { role: "ADMIN", email: "hourly-admin@example.com", payType: "HOURLY" },
    ];
    for (const owner of cases) {
        for (const hourlyRate of [0, 25]) {
            // Manual entries always carry hours > 0, so hours × rate is $0
            // exactly when the rate is.
            const laborCost = 4 * hourlyRate;
            assert.equal(
                zeroLaborBlocks(owner, laborCost),
                zeroRateBlocks({ ...owner, hourlyRate }),
                `${owner.role}/${owner.payType} at $${hourlyRate}/h`
            );
        }
    }
    // The control: this truth table is not uniformly one value.
    assert.equal(zeroLaborBlocks({ role: "FIELD_CREW", payType: "HOURLY" }, 0), true);
    assert.equal(zeroLaborBlocks({ role: "FIELD_CREW", payType: "HOURLY" }, 100), false);
});

test("a caller-supplied $0 labor cost is blocked exactly like a $0 stored rate", () => {
    // The MCP failure story, as a predicate. zeroRateBlocks cannot see this
    // case at all: the rate could be $30/h and the caller still hands over $0.
    const hourly = { role: "FIELD_CREW", email: "garrett@example.com", payType: "HOURLY" };
    assert.equal(zeroRateBlocks({ ...hourly, hourlyRate: 30 }), false, "the rate looks fine");
    assert.equal(zeroLaborBlocks(hourly, 0), true, "the entry does not");

    // And the salaried stay exempt, whichever way the $0 arrived — a salaried
    // MANAGER's $0 hourly rate is CORRECT and must not be flagged.
    const salaried = { role: "MANAGER", email: "cj@goldentouchremodeling.com", payType: "SALARY" };
    assert.equal(isSalariedOwner(salaried), true);
    assert.equal(zeroLaborBlocks(salaried, 0), false);
});

test("createTimeEntryCore reads the owner and applies the policy UNCONDITIONALLY", () => {
    const body = createCoreBody();
    const tx = body.slice(body.indexOf("withPayrollWriteTx("));
    assert.ok(tx.length > 200, "the transaction body is empty — the parser is matching nothing");

    // The read is not inside an `if`. This is the whole regression: it used to
    // sit behind `if (data.priceFromStoredRates)`, which made the guard
    // reachable only by callers that had already opted into being priced.
    assert.match(tx, /const member = await readOwnerRatesForUpdate\(tx, data\.userId/);
    const readIndex = tx.indexOf("readOwnerRatesForUpdate");
    const branchIndex = tx.indexOf("data.priceFromStoredRates");
    assert.ok(readIndex < branchIndex, "the owner must be read BEFORE any pricing branch, for every caller");

    // The decision is taken on the number about to be stored, and the block is
    // still escapable only by an explicit acknowledgement.
    assert.match(tx, /const zeroRate = zeroLaborBlocks\(member, priced\.laborCost\)/);
    assert.match(tx, /if \(zeroRate && data\.acknowledgeZeroRate !== true\)/);
    assert.match(tx, /throw new Error\(zeroRateManagerMessage\(member\.name\)\)/);
    // Acknowledged means FLAGGED, not silent.
    assert.match(tx, /zeroRate \? appendZeroRateReview\(null\) : null/);
    assert.match(tx, /needsReview: true/);
});

test("nothing in src/ can hand createTimeEntryCore its own cost", () => {
    // The strongest form of the fix: the priced path is the only door. The one
    // remaining call site is the stored-rates wrapper itself, so no caller can
    // name a labor cost for an hourly user even by accident.
    const core = read(CORE);
    const wrapper = core.slice(core.indexOf("export async function createTimeEntryFromStoredRatesCore"));
    assert.match(wrapper, /createTimeEntryCore\(\{ \.\.\.data, priceFromStoredRates: true \}, actor\)/);

    const callers: string[] = [];
    for (const file of [MCP, ACTIONS, LOGISTICS_ROUTE, "src/lib/time-expense-actions.ts", "src/app/projects/[id]/timeclock/actions.ts"]) {
        if (/createTimeEntryCore\s*\(/.test(read(file))) callers.push(file);
    }
    assert.deepEqual(callers, [], "these call the unpriced core directly and can supply their own labor cost");

    // The control: the wrapper's own call site IS found by the same pattern,
    // so an empty result above means "none", not "the regex is broken".
    assert.ok(/createTimeEntryCore\s*\(/.test(core));
});

test("the MCP log_time tool prices from stored rates and never names a labor cost", () => {
    const source = read(MCP);
    // The REGISTRATION, not the name's first mention: both names also appear in
    // the exported tool-list constant near the top of the file.
    const registration = (name: string) => new RegExp(`registerTool\\(\\s*"${name}"`).exec(source);
    const start = registration("log_time");
    const end = registration("log_expense");
    assert.ok(start, "the log_time registration moved");
    assert.ok(end && end.index > start.index, "log_expense no longer follows log_time");
    const tool = source.slice(start.index, end.index);
    assert.ok(tool.length > 500, "the tool body is empty — the parser is matching nothing");

    assert.match(tool, /await createTimeEntryFromStoredRatesCore\(\{/);
    assert.doesNotMatch(tool, /calculateCrewTimeCosts\(/, "the tool no longer computes costs itself");
    assert.doesNotMatch(tool, /hourlyRate/, "it no longer reads a rate to price with");

    // The ARGUMENT object, not the response — the response legitimately echoes
    // `laborCost: Number(entry.laborCost)`, which is what the database stored.
    const callStart = tool.indexOf("createTimeEntryFromStoredRatesCore({");
    const args = tool.slice(callStart, tool.indexOf('}, "ChatGPT connector")', callStart));
    assert.ok(args.length > 100, "the call arguments are empty — the parser is matching nothing");
    assert.doesNotMatch(args, /laborCost/, "a chat client must not be able to price somebody's labor");
    // Burden survives as an explicit override — it is a real per-entry number.
    assert.match(args, /burdenCostOverride: burdenCost/);
    // The refusal reaches the operator as a tool error, not a 500.
    assert.match(tool, /isError: true/);
    // And it never acknowledges a $0 rate on somebody's behalf.
    assert.doesNotMatch(tool, /acknowledgeZeroRate/);
});

// ── 2. the change-order tag race ─────────────────────────────────────────────

test("the tag conflict error is 409 and recognised by NAME", () => {
    const error = new TimeEntryTagConflictError("moved");
    assert.equal(error.status, 409);
    assert.equal(isTimeEntryTagConflictError(error), true);

    // Name-based, so a second copy of the module in one process (tsx, Node's
    // loader) does not turn a 409 into an unhandled 500.
    const fromAnotherCopy = Object.assign(new Error("moved"), { name: "TimeEntryTagConflictError" });
    assert.equal(isTimeEntryTagConflictError(fromAnotherCopy), true);

    // The control: it is not simply true for everything.
    assert.equal(isTimeEntryTagConflictError(new Error("moved")), false);
    assert.equal(isTimeEntryTagConflictError(null), false);
});

test("tagging re-validates INSIDE the lock and pins projectId in the write", () => {
    const guarded = tagGuardedBody();

    // Re-read, under the row locks acquirePayrollLocks has already taken.
    assert.match(guarded, /await resolveChangeOrder\(input\.changeOrderId, undefined, db\)/);
    assert.match(guarded, /const locked = await db\.timeEntry\.findMany\(/);
    assert.match(guarded, /locked\.some\(\(row\) => row\.projectId !== changeOrder\.projectId\)/);
    assert.match(guarded, /locked\.some\(\(row\) => row\.invoiceId \|\| row\.invoicedAt\)/);

    // The database has the last word: a row that moved jobs between the re-read
    // and the update simply does not match.
    const where = guarded.slice(guarded.indexOf("updateMany({"), guarded.indexOf("data: { changeOrderId"));
    assert.match(where, /projectId: changeOrder\.projectId/);
    assert.match(where, /invoiceId: null/);
    assert.match(where, /invoicedAt: null/);

    // All or nothing — a short count rolls the transaction back, so "409" also
    // means "nothing was tagged".
    assert.match(guarded, /if \(updated\.count !== ids\.length\) throw new TimeEntryTagConflictError/);
});

test("both project-changing writers REFUSE a change-order-tagged entry", () => {
    // Refuse, not clear: dropping somebody's cost-plus tag as a side effect of
    // a re-route is not a decision either of these gets to make. Nothing in the
    // code documents clear-on-move.
    const route = read(LOGISTICS_ROUTE);
    assert.match(route, /changeOrderId: true,/, "the route must SELECT the tag before it can refuse on it");
    assert.match(route, /if \(entry\.changeOrderId != null\)/);
    assert.match(route, /code: "CHANGE_ORDER_TAGGED"/);
    assert.match(route, /\{ status: 409 \}/);
    // And pinned at write time, for a tag that lands after the read.
    assert.match(route, /routing \? \{ invoiceId: null, invoicedAt: null, changeOrderId: null \}/);

    const actions = read(ACTIONS);
    const reroute = actions.slice(actions.indexOf("export async function rerouteLogisticsEntry"));
    const body = reroute.slice(0, reroute.indexOf("revalidatePath(\"/manager/logistics\")"));
    assert.ok(body.length > 500, "the reroute body is empty — the parser is matching nothing");
    assert.match(body, /if \(entry\.changeOrderId != null\)/);
    assert.match(body, /remove the change-order tag before re-routing it/);
    // Both claims — restore-to-overhead and route-to-job — pin the tag.
    const pins = body.match(/invoiceId: null, invoicedAt: null, changeOrderId: null/g) ?? [];
    assert.equal(pins.length, 2, "both reroute writes must pin changeOrderId, not just one");
});
