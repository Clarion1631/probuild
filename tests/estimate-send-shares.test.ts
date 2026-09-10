/**
 * Sending an estimate must also SHARE it.
 *
 * EST-00514 (2026-09-09) reached a real client. The AI estimate creator
 * (src/lib/gpt-estimate.ts) writes new estimates with `privacy: "Private"` on
 * purpose, so AI pricing stays out of the portal until a human reviews it.
 * `sendEstimateToClient` — the human review-and-share act behind both the UI
 * Send button and the MCP `send_estimate` tool — stamped `sentAt` and the status
 * and never touched `privacy`. portalVisibleEstimateWhere() treats "Private" as
 * an absolute override, so the "View & Sign Estimate" link in the email we had
 * just sent landed on notFound() for the client. Five prod estimates were in
 * that state, and no UI anywhere exposes a privacy toggle, so the contractor
 * could not fix it either.
 *
 * WHY THIS IS A UNIT TEST AND NOT AN E2E
 * --------------------------------------
 * The natural regression net is behavioural: send as staff, then open the
 * estimate as the owning client and watch the 404 turn into a 200 (the read
 * half of that pair is already e2e/portal-estimate-access.spec.ts, which stayed
 * green throughout the outage — it asserts the gate, and the gate was right).
 * That test cannot be written hermetically today. sendEstimateToClient returns
 * BEFORE the send-stamp when the email fails, so the test needs a successful
 * send, and the Playwright CI job supplies a real `RESEND_API_KEY` — so every
 * PR would fire a live Resend call, hard-bounce at the fixture address, and BCC
 * the internal copy address (email.ts's `copyToInternal`) to a real inbox. The
 * suite's own convention is the opposite: e2e/money-pipeline.spec.ts notes its
 * fixture client has NO email precisely "so no real emails can leave this
 * spec". Making the send hermetic needs an email mock alongside the existing
 * E2E_STORAGE_MOCK / E2E_QBO_MOCK pair, which is a bigger, separate change.
 *
 * So this pins the invariant from two hermetic sides instead:
 *   1. the send-stamp VALUE is not excluded by the gate's own privacy clause,
 *      read out of portalVisibleEstimateWhere() rather than restated here; and
 *   2. sendEstimateToClient's send-stamp write actually goes through that
 *      value — checked over the AST, not the source text, because a rename or
 *      a `//` in a string defeats text matching (the #374 lesson).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { portalVisibleEstimateWhere, sentEstimateUpdateData } from "../src/lib/estimate-portal-visibility";

const ACTIONS_PATH = "src/lib/actions.ts";

test("the send-stamp carries a status, a sentAt and a privacy", () => {
    const stamp = sentEstimateUpdateData("Sent");
    assert.equal(stamp.status, "Sent");
    assert.equal(stamp.privacy, "Shared");
    assert.ok(stamp.sentAt instanceof Date, "sentAt must be a real Date the gate can compare against null");
});

test("a resend does not walk an already-transitioned estimate backwards", () => {
    // The caller computes the status (a resend of an Approved/Invoiced estimate
    // must keep it); the helper only carries it. If it ever hardcoded "Sent",
    // resending a signed estimate would reopen it.
    for (const status of ["Approved", "Invoiced", "Partially Paid", "Paid"]) {
        assert.equal(sentEstimateUpdateData(status).status, status);
    }
});

test("the send-stamp satisfies portalVisibleEstimateWhere() rather than tripping it", () => {
    // Read the gate's own clauses instead of restating them. A second, drifting
    // copy of that predicate is exactly what estimate-portal-visibility.ts's
    // closing comment forbids — this asserts the two AGREE, it does not
    // reimplement one of them.
    const where = portalVisibleEstimateWhere() as {
        privacy?: { not?: unknown };
        OR?: Array<{ sentAt?: { not?: unknown } }>;
    };

    const excludedPrivacy = where.privacy?.not;
    assert.equal(
        typeof excludedPrivacy, "string",
        "the gate must still exclude a privacy value by name — if this changed, the send-stamp below is being compared against nothing",
    );

    const stamp = sentEstimateUpdateData("Sent");
    assert.notEqual(
        stamp.privacy, excludedPrivacy,
        `the send writes privacy "${stamp.privacy}" and the portal gate hides "${String(excludedPrivacy)}" — EST-00514 is exactly these two being the same string`,
    );

    // Not excluded is only half of it: the gate also demands POSITIVE evidence
    // of sharing, and `sentAt` is the arm this write satisfies.
    const arms = where.OR ?? [];
    assert.ok(
        arms.some((arm) => arm?.sentAt && arm.sentAt.not === null),
        "the gate must still accept a non-null sentAt as evidence of sharing",
    );
    assert.notEqual(stamp.sentAt, null);
});

// ── The write actually uses it ───────────────────────────────────────────────

function sourceFile(): ts.SourceFile {
    const path = join(process.cwd(), ACTIONS_PATH);
    return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function findFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
    let found: ts.FunctionDeclaration | undefined;
    source.forEachChild((node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    });
    assert.ok(found, `${name} must remain a top-level function declaration in ${ACTIONS_PATH}`);
    return found;
}

/** Every `prisma.estimate.update(...)` / `.updateMany(...)` inside a function. */
function estimateUpdateCalls(fn: ts.Node): ts.CallExpression[] {
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const method = node.expression.name.text;
            const target = node.expression.expression;
            if (
                (method === "update" || method === "updateMany")
                && ts.isPropertyAccessExpression(target)
                && target.name.text === "estimate"
                && ts.isIdentifier(target.expression)
                // `tx` as well as `prisma`: a future transaction-scoped rewrite
                // of this write must not slip past the check by renaming the client.
                && (target.expression.text === "prisma" || target.expression.text === "tx")
            ) {
                calls.push(node);
            }
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn, visit);
    return calls;
}

/** The `data:` initializer of a Prisma write's argument object, if it has one. */
function dataArgument(call: ts.CallExpression): ts.Expression | undefined {
    const [arg] = call.arguments;
    if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
    for (const prop of arg.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "data") {
            return prop.initializer;
        }
    }
    return undefined;
}

function callsHelper(expr: ts.Expression | undefined): boolean {
    return !!expr
        && ts.isCallExpression(expr)
        && ts.isIdentifier(expr.expression)
        && expr.expression.text === "sentEstimateUpdateData";
}

function literalKeys(expr: ts.Expression | undefined): string[] {
    if (!expr || !ts.isObjectLiteralExpression(expr)) return [];
    return expr.properties.flatMap((prop) =>
        ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) ? [prop.name.text] : []
    );
}

test("sendEstimateToClient stamps the send through sentEstimateUpdateData", () => {
    const send = findFunction(sourceFile(), "sendEstimateToClient");
    const writes = estimateUpdateCalls(send).map(dataArgument);

    assert.ok(
        writes.some(callsHelper),
        "sendEstimateToClient must write its send-stamp with sentEstimateUpdateData(...) — that helper is what carries privacy alongside sentAt",
    );

    // The negative half. The positive assertion above still passes if someone
    // ADDS a second, hand-rolled `{ sentAt: new Date(), status }` write next to
    // the helper — which is precisely the shape the bug had. Any estimate write
    // in this action that sets sentAt must be the helper.
    const handRolled = writes.filter((data) => literalKeys(data).includes("sentAt"));
    assert.deepEqual(
        handRolled.map(literalKeys), [],
        "sendEstimateToClient must not set sentAt from an inline object literal — that write has to carry privacy too, so it goes through sentEstimateUpdateData",
    );
});
