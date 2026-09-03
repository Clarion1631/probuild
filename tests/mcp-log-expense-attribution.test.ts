/**
 * `log_expense`'s URL used a SECOND estimate lookup instead of the resolved
 * attribution (Codex round 15, item 4). `createExpenseCore` already stamps
 * `projectId` from the locked pair it wrote (time-expense-core.ts), so the
 * MCP tool re-querying `prisma.estimate.findUnique({ where: { id:
 * expense.estimateId ?? "" } })` and reading `estimate?.projectId` was a
 * second, narrower opinion — and with `Expense_estimateId_fkey` now `ON
 * DELETE SET NULL` (round 42, item 4b), an estimate deleted in the gap
 * between the create and this lookup makes `estimate` come back null and
 * silently drops a valid link, despite `projectId` sitting right there on
 * the row `createExpenseCore` already returned.
 *
 * The fix composes the one resolver, `resolveExpenseProjectId` in
 * src/lib/expense-attribution.ts. That function's own behavioural coverage —
 * BOTH shapes: the column present directly, and the estimate-fallback/absent
 * cases — lives in tests/expense-attribution.test.ts
 * ("resolveExpenseProjectId: column wins, estimate is the fallback, else
 * null"); this file only pins that the MCP route actually calls it instead
 * of reconstructing the old query.
 *
 * A source check, not an end-to-end MCP call: the tool handler is a closure
 * registered inline via `server.registerTool(...)` inside a 2,700+ line
 * route file with no exported per-tool entry point, so pulling the
 * `log_expense` handler out to invoke directly would mean re-building the
 * whole mcp-handler + zod registration harness for one assertion. The shape
 * this test pins — which query the handler runs, and that it no longer
 * exists — is exactly what a route-level integration test would also be
 * checking, one level removed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const routeSource = readFileSync(
    path.join(__dirname, "..", "src", "app", "api", "mcp", "[transport]", "route.ts"),
    "utf8",
);

function logExpenseHandlerSource(): string {
    const toolAt = routeSource.indexOf('"log_expense",');
    assert.ok(toolAt > -1, "log_expense tool registration not found");
    const handlerAt = routeSource.indexOf("async ({ changeOrderId, estimateId, amount, vendor, date, description, receiptFileId })", toolAt);
    assert.ok(handlerAt > -1, "log_expense handler not found");
    const nextToolAt = routeSource.indexOf('server.registerTool(', handlerAt);
    return routeSource.slice(handlerAt, nextToolAt > -1 ? nextToolAt : handlerAt + 3000);
}

test("resolveExpenseProjectId is imported", () => {
    assert.match(
        routeSource,
        /import\s*\{\s*resolveExpenseProjectId\s*\}\s*from\s*"@\/lib\/expense-attribution"/,
    );
});

test("log_expense's URL is built from the resolved attribution, not a second estimate query", () => {
    const handler = logExpenseHandlerSource();
    assert.match(handler, /resolveExpenseProjectId\(expense\)/, "must call the shared resolver");
    // The old, narrower query must be gone from this handler specifically —
    // not merely present elsewhere in the file for a different tool.
    assert.ok(
        !/prisma\.estimate\.findUnique\(\{\s*where:\s*\{\s*id:\s*expense\.estimateId/.test(handler),
        "the old estimate re-lookup must not survive alongside the fix",
    );
});

test("every other expense-facing link in the MCP route already composes the resolver", () => {
    // Audited (Codex round 15, item 4): every OTHER place in this route that
    // builds a URL or reads a project off an expense's estimate already goes
    // through resolveExpenseProjectId / resolveExpenseProjectLabel.
    // `log_time`'s URL (a TimeEntry, not an Expense) is a different model and
    // is not part of this audit.
    const matches = [...routeSource.matchAll(/expense\.estimate\??\.projectId/g)];
    assert.deepEqual(matches, [], "a raw expense.estimate.projectId read reappeared in the MCP route");
});
