import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(__dirname, "../src");
// These collection reads retain source rows for authorization/locking. They
// must never be reused as operational totals. Unique-ID reads likewise retain
// source for ownership, immutable-history replay and guarded mutation checks.
const retained: Record<string, string> = {
    "lib/actions.ts:3267": "estimate-item deletion retains historical source evidence",
    "lib/actions.ts:5483": "estimate deletion retains historical source evidence",
    "lib/payroll-parent-delete.ts:96": "parent deletion refuses any retained source row",
    "lib/actions.ts:3661": "structural deletion must see retained historical evidence",
    "lib/time-expense-actions.ts:254": "bulk deletion authorization reads original ownership",
    "lib/time-expense-actions.ts:281": "bulk deletion rechecks ownership under row locks",
    "lib/time-expense-core.ts:420": "reassignment authorization reads original ownership",
    "lib/time-expense-core.ts:446": "reassignment rechecks source under payroll row locks",
};

function collectionReads() {
    const reads: Array<{ key: string; guarded: boolean }> = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(file); continue; }
            if (!/\.tsx?$/.test(file)) continue;
            const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
            const visit = (node: ts.Node) => {
                if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
                    /^(findMany|findFirst|findFirstOrThrow|aggregate|groupBy|count)$/.test(node.expression.name.text) &&
                    ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === "timeEntry") {
                    const arg = node.arguments[0];
                    const where = arg && ts.isObjectLiteralExpression(arg) ? arg.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === "where") : undefined;
                    const expression = where && ts.isPropertyAssignment(where) ? where.initializer.getText(source) : "";
                    reads.push({ key: `${path.relative(root, file).replaceAll(path.sep, "/")}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
                        guarded: /nonVoidedTimeEntryWhere\(/.test(expression) || /voidedAt:\s*null/.test(expression) });
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
        }
    };
    walk(root); return reads;
}

test("every TimeEntry collection read excludes voids or documents retained-source use", () => {
    const reads = collectionReads();
    assert.ok(reads.filter(row => row.guarded).length >= 35, "scanner must find operational readers");
    assert.deepEqual(reads.filter(row => !row.guarded).map(row => row.key).sort(), Object.keys(retained).sort());
    for (const reason of Object.values(retained)) assert.ok(reason.length > 30);
});

test("nested operational relations and SQL readers keep explicit void exclusions", () => {
    const relations = ["app/api/ai/sub-performance/route.ts", "app/api/mcp/[transport]/route.ts", "app/reports/profitability/page.tsx", "lib/actions.ts"];
    for (const file of relations) {
        const source = readFileSync(path.join(root, file), "utf8");
        const relations = [...source.matchAll(/timeEntries:\s*\{[^\n]+(?:select|include):/g)];
        assert.ok(relations.length);
        for (const relation of relations) assert.match(relation[0], /where: nonVoidedTimeEntryWhere\(/, file);
    }
    for (const file of ["lib/wa-breaks-db.ts", "lib/billing-core.ts", "lib/gusto-export-db.ts"]) {
        const source = readFileSync(path.join(root, file), "utf8");
        const queries = [...source.matchAll(/`[^`]*FROM "TimeEntry"[^`]*`/g)];
        assert.ok(queries.length);
        for (const query of queries) assert.match(query[0], /"voidedAt" IS NULL/, file);
    }
});
