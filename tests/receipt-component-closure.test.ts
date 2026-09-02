import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    COMPETING_LINE_ADJACENCY_DAYS,
    ComponentTooLargeError,
    groupCompetingLines,
    loadComponentToClosure,
} from "../src/lib/receipt-requests";

/**
 * The OCC recompute has to see the SAME competition set the batch saw, or the
 * two disagree and the sweep opens and closes the same chase forever. A fixed
 * window cannot do that: a chain of same-amount charges four days apart reaches
 * further than any span you pick.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86_400_000;
const ymd = (offsetDays: number) => new Date(Date.parse("2026-08-01T00:00:00Z") + offsetDays * DAY).toISOString().slice(0, 10);

/** A fake loader over a fixed set of dated rows, recording every window asked for. */
function loaderOver(offsets: number[]) {
    const rows = offsets.map(offset => ({ id: `bl-${offset}`, postedDate: ymd(offset) }));
    const windows: Array<[string, string]> = [];
    return {
        windows,
        rows,
        load: async (fromYmd: string, toYmd: string) => {
            windows.push([fromYmd, toYmd]);
            return rows.filter(row => row.postedDate >= fromYmd && row.postedDate <= toYmd);
        },
    };
}

test("a 3-hop chain is followed to its end, four days at a time", async () => {
    // 0 ↔ 4 ↔ 8 ↔ 12. No two ends are within the link rule of each other, and
    // the old ±8-day window around the seed stopped at the second hop — so the
    // recompute matched a fragment and got a different answer from the batch.
    assert.equal(COMPETING_LINE_ADJACENCY_DAYS, 4);
    const { load, windows } = loaderOver([0, 4, 8, 12]);
    const found = await loadComponentToClosure(ymd(0), load, { maxNodes: 200 });

    assert.deepEqual(found.map(r => r.id), ["bl-0", "bl-4", "bl-8", "bl-12"]);
    // It really did WALK — each pass asked for a wider window than the last.
    assert.ok(windows.length >= 4, `expected one pass per hop, saw ${windows.length}`);
    assert.deepEqual(windows[0], [ymd(-4), ymd(4)], "the first pass is the seed ± the link rule");
    assert.equal(windows[windows.length - 1][1], ymd(16), "the last reaches past the far end");
    // And the walk STOPS: one pass per hop, plus a final confirming pass that
    // reaches further and finds nothing new.
    assert.equal(windows.length, 4, "three hops and a confirmation");
    assert.ok(windows[3][1] > windows[2][1], "the confirming pass really did look further");

    // The result really is ONE component under the same rule the batch uses.
    const component = groupCompetingLines(found.map(r => ({ ...r, amountCents: -4_600 })));
    assert.equal(component.length, 1);
    assert.equal(component[0].lineIds.length, 4);
});

test("a gap wider than the link rule ends the walk", async () => {
    // 0 ↔ 4, then nothing until 20. The far line competes with none of them and
    // must not be dragged in — a component that is too WIDE misallocates
    // evidence just as surely as one that is too narrow.
    const { load } = loaderOver([0, 4, 20]);
    const found = await loadComponentToClosure(ymd(0), load, { maxNodes: 200 });
    assert.deepEqual(found.map(r => r.id), ["bl-0", "bl-4"]);
});

test("a lone line is its own component, in one pass", async () => {
    const { load, windows } = loaderOver([0]);
    const found = await loadComponentToClosure(ymd(0), load, { maxNodes: 200 });
    assert.deepEqual(found.map(r => r.id), ["bl-0"]);
    assert.equal(windows.length, 2, "one pass to find it, one to confirm nothing else joins");
});

test("an unbounded chain ABORTS rather than truncating", async () => {
    // A card on a daily subscription chains forever. Truncating would be a
    // wrong answer wearing a right one's clothes; the caller has to be told.
    const { load } = loaderOver(Array.from({ length: 300 }, (_, i) => i * 2));
    await assert.rejects(
        () => loadComponentToClosure(ymd(0), load, { maxNodes: 200 }),
        (error: unknown) => {
            assert.ok(error instanceof ComponentTooLargeError);
            assert.ok(error.count > 200);
            assert.equal(error.cap, 200);
            return true;
        },
    );
});

test("the recompute walks to closure, and an abort leaves the chase OPEN", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /const MAX_COMPONENT_LINES = 200;/);
    assert.match(source, /loadComponentToClosure\(/);
    // One past the cap, so an oversized component is detected, not truncated.
    assert.match(source, /take: MAX_COMPONENT_LINES \+ 1,/);
    // The fixed ±8-day window is gone from this path.
    assert.doesNotMatch(source, /const competing = competingLineFilter\(\{[\s\S]{0,200}const range = await evidenceRange\(competing\.from/);
    // Returning [] on an abort would CLEAR the issue — closing a chase because
    // we could not look, not because a receipt exists.
    assert.match(source, /if \(error instanceof ComponentTooLargeError\) \{[\s\S]{0,900}return \["MISSING_RECEIPT"\];/);
    // The loaded window is reduced to the component that holds the seed.
    assert.match(source, /groupCompetingLines\(loadedLines\)\.find\(group => group\.lineIds\.includes\(targetKey\)\)/);
});
