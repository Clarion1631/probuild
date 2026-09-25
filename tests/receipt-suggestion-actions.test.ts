/**
 * Source/AST scan of suggestion-actions.ts (checker, PR #555 round 3,
 * finding 2, mutation proof): tests/receipt-suggestion-core.test.ts only
 * exercises the extracted core -- it imports suggestion-core.ts directly,
 * never suggestion-actions.ts itself, because that file starts with "use
 * server" and is not import-safe for a plain unit test. In a scratch copy,
 * replacing suggestion-actions.ts's `return
 * decideReceiptIntakeJobFromSuggestion(...)` with a direct
 * `return setReceiptIntakeJob(...)` left every other test in the round-3
 * set (server-action-gates, receipt-folder, receipt-suggestion-core,
 * receipt-todo-render, receipt-intake-read, receipts-data) passing 112/112 --
 * nothing checked that the wrapper actually goes through the core. This
 * scans the wrapper's own source, AST-based like
 * tests/server-action-gates.test.ts (so a comment, a string, or a renamed
 * export cannot satisfy it), and fails on exactly that mutation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const FILE = "src/lib/receipt-intake/suggestion-actions.ts";
const FUNCTION_NAME = "setReceiptIntakeJobFromSuggestion";
const GATE_NAMES = ["getCurrentUserWithPermissions", "hasPermission", "canAccessProject"];

function load(): ts.SourceFile {
    const src = readFileSync(FILE, "utf8");
    return ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true);
}

function findExportedFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
    let found: ts.FunctionDeclaration | undefined;
    const visit = (node: ts.Node) => {
        if (
            ts.isFunctionDeclaration(node)
            && node.name?.getText(sf) === name
            && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
            found = node;
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    assert.ok(found?.body, `${name} must be an exported function declaration with a body in ${FILE}`);
    return found!;
}

test("setReceiptIntakeJobFromSuggestion returns decideReceiptIntakeJobFromSuggestion(..., { setJob: setReceiptIntakeJob })", () => {
    const sf = load();
    const fn = findExportedFunction(sf, FUNCTION_NAME);

    let returnCall: ts.CallExpression | undefined;
    const findReturn = (node: ts.Node) => {
        if (ts.isReturnStatement(node) && node.expression && ts.isCallExpression(node.expression)) {
            returnCall = node.expression;
        }
        ts.forEachChild(node, findReturn);
    };
    findReturn(fn.body!);

    assert.ok(returnCall, `${FUNCTION_NAME} must end by returning a call expression`);
    assert.ok(
        ts.isIdentifier(returnCall!.expression) && returnCall!.expression.text === "decideReceiptIntakeJobFromSuggestion",
        `the returned call must be decideReceiptIntakeJobFromSuggestion(...), got: ${returnCall!.expression.getText(sf)}`,
    );

    const depsArg = returnCall!.arguments.find((a): a is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(a));
    assert.ok(depsArg, "decideReceiptIntakeJobFromSuggestion must be called with a dependencies object literal");
    const setJobProp = depsArg!.properties.find(
        (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === "setJob",
    );
    assert.ok(setJobProp, "the dependencies object literal must have a setJob property");
    assert.equal(
        setJobProp!.initializer.getText(sf),
        "setReceiptIntakeJob",
        "setJob must be the real setReceiptIntakeJob (src/lib/actions.ts), passed by reference, not a different or wrapped function",
    );
});

test("setReceiptIntakeJob is never called directly in suggestion-actions.ts", () => {
    const sf = load();
    const directCalls: string[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "setReceiptIntakeJob") {
            directCalls.push(node.getText(sf));
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    assert.deepEqual(
        directCalls,
        [],
        `setReceiptIntakeJob must never be invoked directly from this module -- every tap must go through ` +
        `decideReceiptIntakeJobFromSuggestion's own write-time re-check. It may only be REFERENCED, as the ` +
        `setJob dependency. Found direct call(s): ${directCalls.join(", ")}`,
    );
});

test("the authorization gates run before any prisma access or the call into decideReceiptIntakeJobFromSuggestion", () => {
    const sf = load();
    const fn = findExportedFunction(sf, FUNCTION_NAME);

    const firstGatePosition = new Map<string, number>();
    const otherPositions: number[] = [];

    const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && GATE_NAMES.includes(node.text) && !firstGatePosition.has(node.text)) {
            firstGatePosition.set(node.text, node.getStart(sf));
        }
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "prisma") {
            otherPositions.push(node.getStart(sf));
        }
        if (
            ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && node.expression.text === "decideReceiptIntakeJobFromSuggestion"
        ) {
            otherPositions.push(node.getStart(sf));
        }
        ts.forEachChild(node, visit);
    };
    visit(fn.body!);

    for (const name of GATE_NAMES) {
        assert.ok(firstGatePosition.has(name), `${FUNCTION_NAME} must reference the gate identifier ${name}`);
    }
    assert.ok(
        otherPositions.length > 0,
        `${FUNCTION_NAME} must contain at least one prisma. access or a call into decideReceiptIntakeJobFromSuggestion to order the gates against`,
    );

    const lastGate = Math.max(...firstGatePosition.values());
    const firstOther = Math.min(...otherPositions);
    assert.ok(
        lastGate < firstOther,
        "every gate identifier (getCurrentUserWithPermissions, hasPermission, canAccessProject) must appear " +
        "before the first prisma. access or the call into decideReceiptIntakeJobFromSuggestion -- " +
        "authorization must run first, before any database read",
    );
});
