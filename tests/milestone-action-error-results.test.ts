/**
 * Milestone refusal errors must reach the client, not be swallowed by
 * Next.js's production masking of thrown Server Action messages.
 *
 * `splitInvoiceMilestones` already returns `{ success: false, error }` on a
 * guard failure instead of throwing (see src/lib/actions.ts) and its client
 * caller (`handleSplit` in InvoiceEditor.tsx) already checks `res.success`
 * before touching UI state. Both are regression locks here. This test
 * extends the same contract to `updatePendingMilestoneAmounts` and
 * `deleteInvoiceMilestone` (and their client handlers `handleSaveEdit` /
 * `handleDeleteMilestone`), whose refusals — e.g. "Only pending milestones
 * can be deleted" — were thrown straight out of the action and, in
 * production, arrived at the client as an opaque generic error with no
 * reason shown.
 *
 * AST-based (TypeScript compiler API), like tests/server-action-gates.test.ts
 * and tests/time-entry-void-readers.test.ts: it locates the real function and
 * statement nodes instead of slicing source text, which breaks on
 * reformatting or an unrelated edit above the function.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const ACTIONS_FILE = "src/lib/actions.ts";
const EDITOR_FILE = "src/app/projects/[id]/invoices/[invoiceId]/InvoiceEditor.tsx";

function parseFile(file: string): ts.SourceFile {
    const src = readFileSync(file, "utf8");
    return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
}

/** A top-level `export async function <name>(...) { ... }` — Test A's server actions. */
function findExportedFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
    let found: ts.FunctionDeclaration | undefined;
    const visit = (node: ts.Node) => {
        if (found) return;
        if (
            ts.isFunctionDeclaration(node)
            && node.name?.getText(sf) === name
            && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
            found = node;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    assert.ok(found, `exported function "${name}" not found in ${sf.fileName}`);
    return found;
}

/** A nested, non-exported `function <name>(...) { ... }` — Test B's client handlers. */
function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
    let found: ts.FunctionDeclaration | undefined;
    const visit = (node: ts.Node) => {
        if (found) return;
        if (ts.isFunctionDeclaration(node) && node.name?.getText(sf) === name) {
            found = node;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    assert.ok(found, `function "${name}" not found in ${sf.fileName}`);
    return found;
}

/** Every call expression under `node`, in source order. */
function collectCalls(node: ts.Node): ts.CallExpression[] {
    const out: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n)) out.push(n);
        ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
}

function calleeText(call: ts.CallExpression, sf: ts.SourceFile): string {
    return call.expression.getText(sf);
}

/** `await <callee>();` as a bare top-level statement (not a variable initializer). */
function isAwaitCallStatement(stmt: ts.Statement, callee: string, sf: ts.SourceFile): boolean {
    if (!ts.isExpressionStatement(stmt)) return false;
    const expr = stmt.expression;
    if (!ts.isAwaitExpression(expr)) return false;
    const call = expr.expression;
    return ts.isCallExpression(call) && calleeText(call, sf) === callee;
}

function getPropertyAssignment(obj: ts.ObjectLiteralExpression, propName: string, sf: ts.SourceFile): ts.PropertyAssignment | undefined {
    for (const p of obj.properties) {
        if (ts.isPropertyAssignment(p) && p.name.getText(sf) === propName) return p;
    }
    return undefined;
}

/** `<expr> as const` where `<expr>` is the `true`/`false` keyword. */
function isBooleanAsConst(node: ts.Expression, sf: ts.SourceFile, value: boolean): boolean {
    const kind = value ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword;
    return ts.isAsExpression(node) && node.expression.kind === kind && node.type.getText(sf) === "const";
}

// ---------------------------------------------------------------------------
// Test A — server actions in src/lib/actions.ts
// ---------------------------------------------------------------------------

type SuccessShape = "result" | "object";

const SERVER_ACTIONS: Array<{ name: string; core: string; successShape: SuccessShape }> = [
    { name: "splitInvoiceMilestones", core: "splitInvoiceMilestonesCore", successShape: "object" },
    { name: "updatePendingMilestoneAmounts", core: "updatePendingMilestoneAmountsCore", successShape: "result" },
    { name: "deleteInvoiceMilestone", core: "deleteInvoiceMilestoneCore", successShape: "object" },
];

for (const { name, core, successShape } of SERVER_ACTIONS) {
    test(`${name}: a core failure returns { success: false, error }, it does not throw`, () => {
        const sf = parseFile(ACTIONS_FILE);
        const fn = findExportedFunction(sf, name);
        assert.ok(fn.body, `${name}: expected a function body`);
        const body = fn.body;
        const topLevel = body.statements;

        // 1. exactly one top-level try statement.
        const tryStatements = topLevel.filter(ts.isTryStatement);
        assert.equal(tryStatements.length, 1, `${name}: expected exactly one top-level try statement, found ${tryStatements.length}`);
        const tryStatement = tryStatements[0];
        const tryIndex = topLevel.indexOf(tryStatement);

        // 2. assertInvoicePermission() is a top-level statement before the try
        // (and, because it is found among the TOP-LEVEL statements rather than
        // inside the try block's own statement list, it is provably not inside
        // the try either) — an auth failure must still throw straight out.
        const assertIndex = topLevel.findIndex((s) => isAwaitCallStatement(s, "assertInvoicePermission", sf));
        assert.ok(assertIndex !== -1, `${name}: expected a top-level "await assertInvoicePermission();"`);
        assert.ok(assertIndex < tryIndex, `${name}: assertInvoicePermission() must run before the try statement`);

        // 3. the core function is called inside the try block, and only there.
        const coreCallsInTry = collectCalls(tryStatement.tryBlock).filter((c) => calleeText(c, sf) === core);
        const coreCallsInFn = collectCalls(body).filter((c) => calleeText(c, sf) === core);
        assert.ok(coreCallsInTry.length > 0, `${name}: expected a call to ${core} inside the try block`);
        assert.equal(coreCallsInFn.length, coreCallsInTry.length, `${name}: ${core} must only be called inside the try block`);

        // 4. the catch clause returns { success: false as const, error: ...e?.message... }.
        const catchClause = tryStatement.catchClause;
        assert.ok(catchClause, `${name}: the try statement must have a catch clause`);
        const catchReturn = catchClause.block.statements.find(ts.isReturnStatement);
        assert.ok(catchReturn, `${name}: the catch block must contain a return statement`);
        const catchExpr = catchReturn.expression;
        assert.ok(catchExpr && ts.isObjectLiteralExpression(catchExpr), `${name}: the catch block must return an object literal`);
        const successProp = getPropertyAssignment(catchExpr, "success", sf);
        assert.ok(successProp, `${name}: the catch's returned object must set "success"`);
        assert.ok(
            isBooleanAsConst(successProp.initializer, sf, false),
            `${name}: the catch's "success" must be "false as const", got: ${successProp.initializer.getText(sf)}`,
        );
        const errorProp = getPropertyAssignment(catchExpr, "error", sf);
        assert.ok(errorProp, `${name}: the catch's returned object must set "error"`);
        assert.ok(
            errorProp.initializer.getText(sf).includes("e?.message"),
            `${name}: "error" must read e?.message, got: ${errorProp.initializer.getText(sf)}`,
        );

        // 5. every revalidatePath(...) call happens after the try statement
        // ends — a refusal must not revalidate any page.
        const revalidateCalls = collectCalls(body).filter((c) => calleeText(c, sf) === "revalidatePath");
        assert.ok(revalidateCalls.length > 0, `${name}: expected at least one revalidatePath(...) call`);
        for (const call of revalidateCalls) {
            assert.ok(
                call.getStart(sf) >= tryStatement.getEnd(),
                `${name}: revalidatePath(...) at position ${call.getStart(sf)} must come after the try statement ends`,
            );
        }

        // 6. a success return still exists after the try statement.
        const afterTry = topLevel.slice(tryIndex + 1);
        const successReturn = afterTry.find(ts.isReturnStatement);
        assert.ok(successReturn, `${name}: expected a return statement after the try statement`);
        if (successShape === "result") {
            assert.equal(successReturn.expression?.getText(sf), "result", `${name}: expected "return result;"`);
        } else {
            const successExpr = successReturn.expression;
            assert.ok(successExpr && ts.isObjectLiteralExpression(successExpr), `${name}: expected the success return to be an object literal`);
            const sProp = getPropertyAssignment(successExpr, "success", sf);
            assert.ok(sProp, `${name}: the success return must set "success"`);
            assert.ok(
                isBooleanAsConst(sProp.initializer, sf, true),
                `${name}: the success return's "success" must be "true as const", got: ${sProp.initializer.getText(sf)}`,
            );
        }

        // 7. the core call is awaited; without the await its rejection
        // escapes the catch.
        for (const call of coreCallsInTry) {
            assert.ok(
                ts.isAwaitExpression(call.parent),
                `${name}: the call to ${core} must be the direct operand of an await, got: ${call.parent.getText(sf)}`,
            );
        }
    });
}

// ---------------------------------------------------------------------------
// Test B — client handlers in InvoiceEditor.tsx
// ---------------------------------------------------------------------------

/** `const res = await <action>(...)` anywhere under `scope`. */
function findResAssignment(scope: ts.Node, action: string, sf: ts.SourceFile): ts.CallExpression | undefined {
    let found: ts.CallExpression | undefined;
    const visit = (node: ts.Node) => {
        if (found) return;
        if (
            ts.isVariableDeclaration(node)
            && node.name.getText(sf) === "res"
            && node.initializer
            && ts.isAwaitExpression(node.initializer)
        ) {
            const call = node.initializer.expression;
            if (ts.isCallExpression(call) && calleeText(call, sf) === action) {
                found = call;
                return;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(scope);
    return found;
}

/** `if (!res.success) { ... }` anywhere under `scope`. */
function findResSuccessGuard(scope: ts.Node, sf: ts.SourceFile): ts.IfStatement | undefined {
    let found: ts.IfStatement | undefined;
    const visit = (node: ts.Node) => {
        if (found) return;
        if (
            ts.isIfStatement(node)
            && ts.isPrefixUnaryExpression(node.expression)
            && node.expression.operator === ts.SyntaxKind.ExclamationToken
            && node.expression.operand.getText(sf) === "res.success"
        ) {
            found = node;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(scope);
    return found;
}

/** `stmt` itself is `const res = await <action>(...)` (no recursive search). */
function isResAssignmentStatement(stmt: ts.Statement, action: string, sf: ts.SourceFile): boolean {
    if (!ts.isVariableStatement(stmt)) return false;
    return stmt.declarationList.declarations.some((decl) => {
        if (decl.name.getText(sf) !== "res" || !decl.initializer || !ts.isAwaitExpression(decl.initializer)) return false;
        const call = decl.initializer.expression;
        return ts.isCallExpression(call) && calleeText(call, sf) === action;
    });
}

/** `stmt` itself is `if (!res.success) { ... }`. */
function isResSuccessGuardStatement(stmt: ts.Statement, sf: ts.SourceFile): stmt is ts.IfStatement {
    return (
        ts.isIfStatement(stmt)
        && ts.isPrefixUnaryExpression(stmt.expression)
        && stmt.expression.operator === ts.SyntaxKind.ExclamationToken
        && stmt.expression.operand.getText(sf) === "res.success"
    );
}

const CLIENT_HANDLERS: Array<{ handler: string; action: string; closeCall: string; loadingFlagCall: string }> = [
    { handler: "handleSplit", action: "splitInvoiceMilestones", closeCall: "setShowSplit(false)", loadingFlagCall: "setIsSplitting(false)" },
    { handler: "handleSaveEdit", action: "updatePendingMilestoneAmounts", closeCall: "handleCancelEditMode()", loadingFlagCall: "setIsSavingEdit(false)" },
    { handler: "handleDeleteMilestone", action: "deleteInvoiceMilestone", closeCall: "setDeleteMilestoneTarget(null)", loadingFlagCall: "setIsDeletingMilestone(false)" },
];

for (const { handler, action, closeCall, loadingFlagCall } of CLIENT_HANDLERS) {
    test(`${handler}: bails out on { success: false } before touching UI state`, () => {
        const sf = parseFile(EDITOR_FILE);
        const fn = findFunction(sf, handler);
        assert.ok(fn.body, `${handler}: expected a function body`);
        const body = fn.body;

        // 1. the action's result is captured.
        const actionCall = findResAssignment(body, action, sf);
        assert.ok(actionCall, `${handler}: expected "const res = await ${action}(...)"`);

        // 2. the guard exists, after the call, before any of: the success
        // toast, the refresh, or the call that closes the UI.
        const guard = findResSuccessGuard(body, sf);
        assert.ok(guard, `${handler}: expected an "if (!res.success)" guard`);
        const guardStart = guard.getStart(sf);
        assert.ok(guardStart > actionCall.getStart(sf), `${handler}: the guard must come after the "${action}(...)" call`);

        const allCalls = collectCalls(body);
        const toastSuccessCall = allCalls.find((c) => calleeText(c, sf) === "toast.success");
        const refreshCall = allCalls.find((c) => calleeText(c, sf) === "router.refresh");
        const closeCallNode = allCalls.find((c) => c.getText(sf) === closeCall);
        assert.ok(toastSuccessCall, `${handler}: expected a toast.success(...) call`);
        assert.ok(refreshCall, `${handler}: expected a router.refresh() call`);
        assert.ok(closeCallNode, `${handler}: expected a "${closeCall}" call`);
        assert.ok(guardStart < toastSuccessCall.getStart(sf), `${handler}: the guard must come before toast.success(...)`);
        assert.ok(guardStart < refreshCall.getStart(sf), `${handler}: the guard must come before router.refresh()`);
        assert.ok(guardStart < closeCallNode.getStart(sf), `${handler}: the guard must come before ${closeCall}`);

        // 3. the guard body reports the reason.
        const thenText = guard.thenStatement.getText(sf);
        assert.match(thenText, /toast\.error\(\s*res\.error\b/, `${handler}: the guard must call toast.error(res.error...)`);

        // 4. source position is not execution order: the guard must be the
        // statement right after the call, directly in the handler's try
        // block, so it can't hide inside a condition that never runs.
        const topLevel = body.statements;
        const tryStatements = topLevel.filter(ts.isTryStatement);
        assert.equal(tryStatements.length, 1, `${handler}: expected exactly one top-level try statement, found ${tryStatements.length}`);
        const tryStatement = tryStatements[0];
        const tryStmts = tryStatement.tryBlock.statements;
        const resIndex = tryStmts.findIndex((s) => isResAssignmentStatement(s, action, sf));
        assert.ok(resIndex !== -1, `${handler}: expected "const res = await ${action}(...)" as a direct statement of the try block`);
        const nextStmt = tryStmts[resIndex + 1];
        assert.ok(
            nextStmt && isResSuccessGuardStatement(nextStmt, sf),
            `${handler}: expected "if (!res.success)" to be the statement immediately after the "${action}(...)" call, got: ${nextStmt?.getText(sf)}`,
        );

        // 5. the refusal branch only reports and bails out: no else, return
        // last, and no happy-path call inside it (step 2's position checks
        // can't see a stray call placed inside the guard).
        // assert.ok, not assert.equal, on ts.Node values: a failing
        // strictEqual inspects both operands for its diff, and inspecting a
        // circular ts.Node runs the process out of memory.
        assert.ok(nextStmt.elseStatement === undefined, `${handler}: the guard must not have an else branch`);
        assert.ok(ts.isBlock(nextStmt.thenStatement), `${handler}: the guard's body must be a block`);
        const guardBlockStatements = nextStmt.thenStatement.statements;
        const lastStmt = guardBlockStatements[guardBlockStatements.length - 1];
        assert.ok(lastStmt && ts.isReturnStatement(lastStmt), `${handler}: the guard block's last statement must be a return`);
        const innerCalls = collectCalls(nextStmt.thenStatement);
        for (const bad of ["toast.success", "toast.warning", "router.refresh", closeCall]) {
            const hit = innerCalls.find((c) => calleeText(c, sf) === bad || c.getText(sf) === bad);
            assert.ok(hit === undefined, `${handler}: the guard block must not call ${bad}`);
        }

        // 6. thrown errors (auth, network) still surface, and the loading
        // flag resets either way: both are direct statements of their block,
        // not nested in a condition.
        const catchClause = tryStatement.catchClause;
        assert.ok(catchClause, `${handler}: the try statement must have a catch clause`);
        assert.ok(
            catchClause.block.statements.some((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && calleeText(s.expression, sf) === "toast.error"),
            `${handler}: the catch block must call toast.error(...) as a direct statement`,
        );
        const finallyBlock = tryStatement.finallyBlock;
        assert.ok(finallyBlock, `${handler}: the try statement must have a finally block`);
        assert.ok(
            finallyBlock.statements.some((s) => ts.isExpressionStatement(s) && s.expression.getText(sf) === loadingFlagCall),
            `${handler}: the finally block must call ${loadingFlagCall} as a direct statement`,
        );
    });
}
