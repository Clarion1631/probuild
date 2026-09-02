import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    COMPETING_LINE_ADJACENCY_DAYS,
    ComponentTooLargeError,
    competingLineFilter,
    componentTouchesBoundary,
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

// ── The open-issue pass walks too (round-15 item 2) ────────────────────────

test("a chain longer than the fixed window is only found by the walk", async () => {
    // 0 ↔ 4 ↔ 8 ↔ 12 again, but read against the OLD expansion: the fixed
    // per-line query spans ±8 days, so the line at day 12 was outside it. The
    // open-issue pass judged the first three as the whole competition set and
    // handed a receipt to a line whose real competitor it never loaded.
    const window = competingLineFilter({ amountCents: -4_600, postedDate: ymd(0) });
    assert.equal(window.from, ymd(-8));
    assert.equal(window.to, ymd(8), "the fixed window stops two hops out");

    const { load } = loaderOver([0, 4, 8, 12]);
    const walked = await loadComponentToClosure(ymd(0), load, { maxNodes: 200 });
    assert.deepEqual(walked.map(r => r.id), ["bl-0", "bl-4", "bl-8", "bl-12"]);
    // The line the fixed window missed, stated as such.
    const missed = walked.filter(r => r.postedDate > window.to);
    assert.deepEqual(missed.map(r => r.id), ["bl-12"]);
});

test("the open-issue pass asks for closure; the line pass keeps the window", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /cohortMode: "window" \| "closure" = "window",/);
    // The open pass passes "closure" explicitly.
    assert.match(source, /page\.map\(issue => \(\{ targetKey: issue\.targetKey \}\)\),[\s\S]{0,400}"closure",/);
    // In closure mode the expansion is per line, through the same walk.
    assert.match(source, /if \(cohortMode === "closure"\) \{[\s\S]{0,300}await loadCompetingComponent\(row\)/);
    // An unloadable component costs that line its verdict — never a close.
    assert.match(source, /judgeOnly\.delete\(row\.id\);/);
    assert.match(source, /undecided: plan\.undecided\.length \+ unresolved\.length/);
    // The line pass still uses the cheap query: its pages ARE components.
    assert.match(source, /const cohortFilters = batch\.map\(row => competingLineFilter\(/);
});

// ── Components at the window edge (round-16 item 1) ────────────────────────

test("a chain that crosses the 60-day boundary is loaded to closure", () => {
    // The line pass groups components over the loaded window, which makes them
    // whole WITHIN it and says nothing about what sits just past the edge. A
    // charge on day 61 linking to one on day 59 is a real competitor the window
    // never loaded — so what the pass holds is a FRAGMENT, and a fragment
    // allocates evidence differently from the whole.
    const start = ymd(0);
    const end = ymd(59);

    // Sitting ON the old edge: its chain may continue behind the window.
    assert.equal(componentTouchesBoundary([ymd(1), ymd(3)], start, end), true);
    // Sitting on the recent edge: a line posted while the sweep ran can join it.
    assert.equal(componentTouchesBoundary([ymd(57)], start, end), true);
    // Exactly one link from either edge still counts.
    assert.equal(componentTouchesBoundary([ymd(4)], start, end), true, "4 days is the link rule");
    assert.equal(componentTouchesBoundary([ymd(55)], start, end), true);
    // The interior is provably complete and keeps the cheap query.
    assert.equal(componentTouchesBoundary([ymd(5), ymd(9)], start, end), false);
    assert.equal(componentTouchesBoundary([ymd(30)], start, end), false);
    // An undateable component is treated as a boundary case, not as interior.
    assert.equal(componentTouchesBoundary(["not-a-date"], start, end), true);
    assert.equal(componentTouchesBoundary([], start, end), true);
});

test("the crossing chain's far half is only found by the walk", async () => {
    // Day 59 and day 61 are one link apart, and day 61 is outside the window.
    // The window query cannot see it; the walk can.
    const { load } = loaderOver([-2, 2, 6]); // -2 is "before the window start"
    const walked = await loadComponentToClosure(ymd(2), load, { maxNodes: 200 });
    assert.deepEqual(walked.map(r => r.id), ["bl--2", "bl-2", "bl-6"]);
    // Grouped over the window ALONE, the out-of-window line is simply absent —
    // which is the fragment the boundary rule exists to avoid judging.
    const inWindowOnly = groupCompetingLines(
        [2, 6].map(offset => ({ id: `bl-${offset}`, postedDate: ymd(offset), amountCents: -4_600 })),
    );
    assert.equal(inWindowOnly[0].lineIds.length, 2, "the window sees two; the truth is three");
});

test("the line pass sends only its edge components through the walk", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /const boundaryLineIds = new Set\(/);
    assert.match(source, /componentTouchesBoundary\(/);
    // Two calls per page: the interior on the cheap query, the edge on the walk.
    assert.match(source, /\[interiorBatch, "window"\],\s*\n\s*\[boundaryBatch, "closure"\],/);
    // And a failure in EITHER still stops the cursor — so does contention.
    assert.match(source, /pageErrors \+= outcome\.summary\.errors;/);
    assert.match(source, /if \(pageErrors > 0 \|\| pageContended > 0\) break;/);
});
