/**
 * Every scripts/apply-*.mjs must be INERT ON IMPORT.
 *
 * Incident (2026-09-02): importing scripts/apply-payroll-phase5.mjs to inspect its
 * exports ran the whole migration against production, because dotenv `config()`
 * and `new PrismaClient(...)` sat at module scope and the DDL was top-level
 * `await`. Roughly twenty sibling scripts shared that shape (one of them even
 * loaded `.env.production.local` first). The fix moves every side effect inside
 * `main()` behind an `import.meta.url === pathToFileURL(process.argv[1]).href`
 * main-module guard. This file makes sure it stays that way, two ways:
 *
 *  1. Source (TypeScript AST, evaluated synchronously at load and asserted
 *     BEFORE any child process is spawned). This is an ALLOWLIST, not a list of
 *     dangerous spellings: at module scope a script may contain only
 *       - `import` declarations with bindings, from an exact allowlist of
 *         modules (no side-effect-only or relative imports, no `dotenv/config`,
 *         no `data:` URLs),
 *       - function declarations (their bodies never run on import),
 *       - `const` / `let` / `var` declarations whose initialisers are inert
 *         (literals, arrays, objects, arrows/function expressions that are not
 *         invoked, and calls only to a few pure path helpers bound by import),
 *       - `export { ... }` lists without a `from` (a re-export loads a module),
 *       - exactly one guard: `const isMainModule = <exact expression>;` then
 *         `if (isMainModule) { ... }` with no `else`, whose block may hold
 *         preflight statements that never mention `main` and must END with
 *         exactly one unconditional `await main();` or
 *         `main().catch(...)[.finally(...)]` chain.
 *     Anything else at module scope (an expression statement, `try`, a loop, a
 *     class, an IIFE, `await`, `new`, a call to anything not on the tiny
 *     allowlist, any reference to `main` outside the guard) is a violation.
 *     `pathToFileURL` / `fileURLToPath` must be bound by an import from
 *     `node:url` / `url` and may not be shadowed.
 *
 *  2. Runtime: each script is imported by a real entrypoint file (so
 *     `process.argv[1]` is truthy and the guard's URL comparison is exercised)
 *     in a child process whose environment holds only a DATABASE_URL /
 *     DIRECT_URL pointing at a TCP listener owned by this test. The import must
 *     exit 0, print nothing that looks like a migration log, and the listener
 *     must see ZERO connections. Controls prove the listener catches a
 *     module-scope query, and that a guarded script DOES run when executed
 *     directly and does NOT when imported. The source check is asserted first
 *     so a regressed script is never imported by this harness.
 *
 * What this does NOT prove: it constrains module-scope syntax and observes TCP
 * connections. It is not a general side-effect analysis.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(root, "scripts");
const scripts = readdirSync(scriptsDir)
    .filter((name) => /^apply-.*\.mjs$/.test(name))
    .sort();

assert.ok(scripts.length > 0, "no scripts/apply-*.mjs found — glob or cwd is wrong");

// ---------------------------------------------------------------------------
// Source check (TypeScript AST, allowlist).
// ---------------------------------------------------------------------------

/** The only accepted guard expressions, whitespace-normalised. */
const GUARD_EXPRESSIONS = new Set([
    "process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href",
    "process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]",
]);

/** Pure helpers a module-scope declaration may call, and the modules they must be imported from. */
const ALLOWED_CALLEES: Record<string, string[]> = {
    pathToFileURL: ["node:url", "url"],
    fileURLToPath: ["node:url", "url"],
    dirname: ["node:path", "path"],
    join: ["node:path", "path"],
    resolve: ["node:path", "path"],
};
const ALLOWED_GLOBAL_CALLEES = new Set(["process.argv.includes", "process.argv.indexOf"]);
/** The only modules an apply script may import. Anything else (a `data:` URL, `dotenv/config`, a driver) runs code on import. */
// `node:dns` is on the list for the same reason as `node:fs`: importing it does
// nothing at all - it opens no socket, reads no environment and starts no work.
// apply-receipt-intake.mjs and apply-phase2-receipt-queue.mjs both resolve
// --expect-host at call time, inside main().
const ALLOWED_IMPORTS = new Set(["@prisma/client", "dotenv", "node:fs", "fs", "node:url", "url", "node:path", "path", "node:crypto", "crypto", "node:dns", "dns"]);
/** Names a script may never declare itself (they would let a guard or helper be spoofed). */
const RESERVED_NAMES = new Set(["process", "import", "pathToFileURL", "fileURLToPath", "dirname", "join", "resolve", "isMainModule"]);

const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

function isFunctionLike(node: ts.Node): boolean {
    return ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

type SourceReport = { violations: string[]; guardIfs: number; mainCallsInGuard: number; hasGuardConst: boolean; hasMain: boolean };

function analyse(name: string, text: string): SourceReport {
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const report: SourceReport = { violations: [], guardIfs: 0, mainCallsInGuard: 0, hasGuardConst: false, hasMain: false };
    const bad = (n: ts.Node, msg: string): void => {
        report.violations.push(`line ${line(n)}: ${msg}`);
    };

    // Pass 1: import bindings and declared names.
    const importBindings = new Map<string, string>(); // local name -> module specifier
    const declaredNames = new Set<string>();
    for (const st of sf.statements) {
        if (ts.isImportDeclaration(st)) {
            const spec = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : "";
            if (!st.importClause) bad(st, `side-effect-only import "${spec}" at module scope`);
            if (!ALLOWED_IMPORTS.has(spec)) bad(st, `import from "${spec}" is not on the allowlist (${[...ALLOWED_IMPORTS].join(", ")})`);
            const clause = st.importClause;
            if (clause?.name) importBindings.set(clause.name.text, spec);
            if (clause?.namedBindings) {
                if (ts.isNamespaceImport(clause.namedBindings)) importBindings.set(clause.namedBindings.name.text, spec);
                else for (const el of clause.namedBindings.elements) importBindings.set(el.name.text, spec);
            }
        } else if (ts.isFunctionDeclaration(st) && st.name) {
            declaredNames.add(st.name.text);
            if (st.name.text === "main") report.hasMain = true;
        } else if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
                if (ts.isIdentifier(d.name)) declaredNames.add(d.name.text);
                else bad(d, "destructuring declaration at module scope is not allowed");
            }
        }
    }
    for (const n of declaredNames) {
        if (RESERVED_NAMES.has(n) && n !== "isMainModule") bad(sf, `module-scope declaration shadows reserved name \`${n}\``);
        if (importBindings.has(n)) bad(sf, `module-scope declaration \`${n}\` shadows an import`);
    }
    for (const [local, spec] of importBindings) {
        if (local === "main") bad(sf, "`main` must be declared in this file, not imported");
        if (RESERVED_NAMES.has(local) && !(ALLOWED_CALLEES[local] ?? []).includes(spec)) bad(sf, `\`${local}\` must be imported from ${ALLOWED_CALLEES[local]?.join(" or ") ?? "nowhere"}, got "${spec}"`);
    }

    /** Is this expression inert if evaluated at module scope? Reports violations for anything that is not. */
    function checkInert(node: ts.Node): void {
        if (ts.isAwaitExpression(node)) return bad(node, "top-level await");
        if (ts.isNewExpression(node)) return bad(node, `new ${node.expression.getText(sf)}(...) at module scope`);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return bad(node, "assignment at module scope");
        if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) return bad(node, "update expression at module scope");
        if (ts.isDeleteExpression(node) || ts.isYieldExpression(node)) return bad(node, "effectful operator at module scope");
        if (ts.isTaggedTemplateExpression(node)) return bad(node, "tagged template at module scope is a call");
        if (ts.isClassExpression(node)) return bad(node, "class expression at module scope");
        if (ts.isIdentifier(node) && node.text === "main") return bad(node, "reference to `main` outside the main-module guard");
        if (isFunctionLike(node)) return; // a function value that is not invoked is inert
        if (ts.isCallExpression(node)) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return bad(node, "dynamic import() at module scope");
            const callee = node.expression.getText(sf);
            const allowedModules = ALLOWED_CALLEES[callee];
            const ok = (allowedModules && allowedModules.includes(importBindings.get(callee) ?? "")) || ALLOWED_GLOBAL_CALLEES.has(callee);
            if (!ok) return bad(node, `call to \`${callee}(...)\` at module scope (only ${[...Object.keys(ALLOWED_CALLEES), ...ALLOWED_GLOBAL_CALLEES].join(", ")} are allowed)`);
            for (const arg of node.arguments) checkInert(arg);
            return;
        }
        ts.forEachChild(node, checkInert);
    }

    const mentionsMain = (n: ts.Node): boolean =>
        (ts.isIdentifier(n) && n.text === "main") || ts.forEachChild(n, mentionsMain) === true;
    const isBareMainCall = (n: ts.Node): boolean =>
        ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "main" && n.arguments.length === 0;

    /** Any function body outside the guard: `main` may not be referenced at all. */
    function scanExecutable(node: ts.Node): void {
        if (ts.isIdentifier(node) && node.text === "main" && !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node)) {
            bad(node, "reference to `main` outside the main-module guard");
        }
        ts.forEachChild(node, scanExecutable);
    }

    /**
     * The guard body may hold preflight statements (flag checks, `prisma = new PrismaClient(...)`)
     * that never mention `main`, and must END with exactly one unconditional entry:
     * `await main();` or a `main().catch(...)[.finally(...)]` chain whose handlers do not mention `main`.
     */
    function checkGuardBody(body: ts.Statement): void {
        if (!ts.isBlock(body)) return bad(body, "the main-module guard body must be a `{ ... }` block");
        const stmts = body.statements;
        if (stmts.length === 0) return bad(body, "the main-module guard body is empty — main() never runs");
        const last = stmts[stmts.length - 1];
        for (const st of stmts.slice(0, -1)) if (mentionsMain(st)) bad(st, "`main` may only appear in the guard's final statement");
        if (!ts.isExpressionStatement(last)) return bad(last, "the guard's final statement must be `await main();` or a `main().catch(...)` chain");
        const expr = last.expression;
        if (ts.isAwaitExpression(expr)) {
            if (!isBareMainCall(expr.expression)) return bad(last, "the guard's final statement must be exactly `await main();`");
            report.mainCallsInGuard = 1;
            return;
        }
        let cur: ts.Expression = expr;
        const chainMethods = new Set(["catch", "finally", "then"]);
        while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression) && chainMethods.has(cur.expression.name.text)) {
            for (const arg of cur.arguments) if (mentionsMain(arg)) bad(arg, "a chain handler may not reference `main`");
            cur = cur.expression.expression;
        }
        if (!isBareMainCall(cur)) return bad(last, "the guard's final statement must be `await main();` or a `main().catch(...)[.finally(...)]` chain");
        report.mainCallsInGuard = 1;
    }

    // Pass 2: every module-level statement must be one of the allowed kinds.
    for (const st of sf.statements) {
        if (ts.isImportDeclaration(st)) continue;
        if (ts.isExportDeclaration(st)) {
            // `export { a, b }` is inert; any re-export with a specifier loads that module on import.
            if (st.moduleSpecifier) bad(st, `re-export from ${st.moduleSpecifier.getText(sf)} at module scope loads another module on import`);
            continue;
        }
        if (ts.isFunctionDeclaration(st)) {
            if (st.body) scanExecutable(st.body);
            continue;
        }
        if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
                if (ts.isIdentifier(d.name) && d.name.text === "isMainModule") {
                    const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
                    const init = d.initializer ? normalise(d.initializer.getText(sf)) : "";
                    if (isConst && GUARD_EXPRESSIONS.has(init)) report.hasGuardConst = true;
                    else bad(st, `isMainModule must be \`const\` and exactly one of the accepted guard expressions, got: ${init || "(no initializer)"}`);
                    continue;
                }
                if (d.initializer) {
                    checkInert(d.initializer);
                    if (isFunctionLike(d.initializer)) scanExecutable(d.initializer);
                }
            }
            continue;
        }
        if (ts.isIfStatement(st) && ts.isIdentifier(st.expression) && st.expression.text === "isMainModule") {
            report.guardIfs += 1;
            if (st.elseStatement) bad(st, "the main-module guard must not have an else branch");
            checkGuardBody(st.thenStatement);
            continue;
        }
        bad(st, `statement of kind ${ts.SyntaxKind[st.kind]} is not allowed at module scope`);
    }

    return report;
}

function problemsOf(r: SourceReport): string[] {
    const problems = [...r.violations];
    if (!r.hasMain) problems.push("no `function main()` declaration");
    if (!r.hasGuardConst) problems.push("missing `const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href`");
    if (r.guardIfs !== 1) problems.push(`expected exactly one module-level \`if (isMainModule)\`, found ${r.guardIfs}`);
    if (r.mainCallsInGuard < 1) problems.push("main() is never called inside the main-module guard");
    return problems;
}

/** Evaluated synchronously at load so every runtime test can refuse to spawn a script that fails it. */
const sourceProblems = new Map<string, string[]>(
    scripts.map((name) => [name, problemsOf(analyse(name, readFileSync(path.join(scriptsDir, name), "utf8")))]),
);

const GUARD_LINE = `const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;`;
const URL_IMPORT = `import { pathToFileURL } from "node:url";`;

test("harness control: the source check rejects the incident shape and the known evasions", () => {
    const cases: Record<string, string> = {
        incident: `import { config } from "dotenv"; import { PrismaClient } from "@prisma/client";
config({ path: ".env.production.local" });
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe("ALTER TABLE x ADD COLUMN y TEXT");`,
        iife: `${URL_IMPORT} import { PrismaClient } from "@prisma/client";
(async () => { const p = new PrismaClient(); await p.$executeRawUnsafe("x"); })();
async function main() {}
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        iifeCall: `${URL_IMPORT}
(async () => { await main(); }).call(null);
async function main() {}
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        inverted: `${URL_IMPORT}
async function main() {}
${GUARD_LINE}
if (!isMainModule) { await main(); }`,
        elseBranch: `${URL_IMPORT}
async function main() {}
${GUARD_LINE}
if (isMainModule) { await main(); } else { await main(); }`,
        emptyGuard: `${URL_IMPORT}
async function main() {}
${GUARD_LINE}
if (isMainModule) {}`,
        looseGuard: `${URL_IMPORT}
async function main() {}
const isMainModule = true;
if (isMainModule) { await main(); }`,
        voidMain: `${URL_IMPORT}
async function main() {}
void main();
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        aliasedMain: `${URL_IMPORT}
async function main() {}
const run = main;
const p = run();
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        thenMain: `${URL_IMPORT}
async function main() {}
const p = Promise.resolve().then(main);
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        dynamicImport: `${URL_IMPORT}
async function main() {}
const p = import("./apply-other.mjs");
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        sideEffectImport: `${URL_IMPORT}
import "./migration-helper.mjs";
async function main() {}
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        aliasedPrisma: `${URL_IMPORT} import { PrismaClient as PC } from "@prisma/client";
const prisma = new PC();
async function main() {}
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        aliasedDotenv: `${URL_IMPORT} import { config as load } from "dotenv";
const env = load({ path: ".env", override: true });
async function main() {}
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        localPathToFileURL: `async function main() {}
function pathToFileURL() { return { href: import.meta.url }; }
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        spoofedImport: `import { pathToFileURL } from "./spoof.mjs";
async function main() {}
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        chainOutside: `${URL_IMPORT}
async function main() {}
main().catch(console.error);
${GUARD_LINE}
if (isMainModule) {}`,
        classAtModuleScope: `${URL_IMPORT}
async function main() {}
class Holder { static { main(); } }
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        reexportStar: `${URL_IMPORT}
async function main() {}
export * from "./evil-side-effect.mjs";
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        reexportNamed: `${URL_IMPORT}
async function main() {}
export { foo } from "./evil-side-effect.mjs";
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        reexportNamespace: `${URL_IMPORT}
async function main() {}
export * as ns from "dotenv";
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        exportDefault: `${URL_IMPORT}
async function main() {}
export default main();
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        dotenvConfigImport: `${URL_IMPORT} import loaded from "dotenv/config";
async function main() {}
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        dataUrlImport: `${URL_IMPORT} import x from "data:text/javascript,globalThis.pwned=1";
async function main() {}
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        unlistedImport: `${URL_IMPORT} import pg from "pg";
async function main() {}
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        objectFreezeSpoof: `${URL_IMPORT}
async function main() {}
const Object = { freeze: () => main() };
const started = Object.freeze();
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        assignmentInInitialiser: `${URL_IMPORT}
async function main() {}
let hook;
const y = (hook = main);
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        updateExpression: `${URL_IMPORT}
async function main() {}
let n = 0;
const m = n++;
${GUARD_LINE}
if (isMainModule) { await main(); }`,
        guardConditional: `${URL_IMPORT}
async function main() {}
${GUARD_LINE}
if (isMainModule) { if (false) await main(); }`,
        guardTwice: `${URL_IMPORT}
async function main() {}
${GUARD_LINE}
if (isMainModule) { await main(); await main(); }`,
        guardMainNotLast: `${URL_IMPORT}
async function main() {}
${GUARD_LINE}
if (isMainModule) { await main(); console.log("done"); }`,
        guardMainWithArgs: `${URL_IMPORT}
async function main() {}
${GUARD_LINE}
if (isMainModule) { await main(process.argv); }`,
        guardThenMain: `${URL_IMPORT}
async function main() {}
${GUARD_LINE}
if (isMainModule) { Promise.resolve().then(main); }`,
        helperInvoked: `${URL_IMPORT}
async function main() {}
function run() { return main(); }
const started = run();
${GUARD_LINE}
if (isMainModule) { await main(); }`,
    };
    for (const [label, src] of Object.entries(cases)) {
        const problems = problemsOf(analyse(label, src));
        assert.ok(problems.length > 0, `source check did not reject the "${label}" shape`);
    }
    const good = `import { PrismaClient } from "@prisma/client"; ${URL_IMPORT} import { config } from "dotenv"; import { fileURLToPath } from "url"; import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const statements = ["SELECT 1", \`ALTER TABLE "x" ADD COLUMN IF NOT EXISTS "y" TEXT\`];
export const EXPECTED = ["y"];
function resolveDatabaseUrl() { return process.env.DATABASE_URL; }
async function main() { config({ path: join(__dirname, "..", ".env") }); const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } }); try { for (const s of statements) await prisma.$executeRawUnsafe(s); } finally { await prisma.$disconnect(); } }
${GUARD_LINE}
if (isMainModule) { await main(); }`;
    assert.deepEqual(problemsOf(analyse("good", good)), [], "source check rejected the canonical good shape");
    const goodChain = `import { PrismaClient } from "@prisma/client"; ${URL_IMPORT}
let url;
let prisma;
async function main() { await prisma.$executeRawUnsafe("SELECT 1"); }
${GUARD_LINE}
if (isMainModule) { url = process.env.DATABASE_URL; prisma = new PrismaClient({ datasources: { db: { url } } }); main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect()); }`;
    assert.deepEqual(problemsOf(analyse("goodChain", goodChain)), [], "source check rejected the catch/finally chain shape");
    const goodLegacy = `import { PrismaClient } from "@prisma/client"; import { fileURLToPath } from "node:url";
const withIndexes = process.argv.includes("--with-indexes");
let prisma;
async function main() {}
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    if (!process.argv.includes("--yes")) { console.error("Refusing to run without --yes"); process.exit(1); }
    prisma = new PrismaClient();
    main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}`;
    assert.deepEqual(problemsOf(analyse("goodLegacy", goodLegacy)), [], "source check rejected the legacy guard shape");
});

for (const name of scripts) {
    test(`source: scripts/${name} has no side effects before main() and guards its entrypoint`, () => {
        const problems = sourceProblems.get(name)!;
        assert.deepEqual(problems, [], `${name}:\n  ${problems.join("\n  ")}`);

        // Belt and braces for the literal incident shape, on comment-stripped
        // text: nothing that loads env, builds a client, or runs DDL may appear
        // textually before the main() declaration.
        const stripped = readFileSync(path.join(scriptsDir, name), "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .split(/\r?\n/)
            .filter((l) => !l.trim().startsWith("//"))
            .join("\n");
        const mainIdx = stripped.search(/(?:async\s+)?function\s+main\s*\(/);
        assert.ok(mainIdx >= 0, `${name}: main() declaration not found in stripped source`);
        const beforeMain = stripped.slice(0, mainIdx);
        for (const marker of ["config({ path:", "config({path:", "new PrismaClient(", "$executeRawUnsafe"]) {
            assert.ok(!beforeMain.includes(marker), `${name}: \`${marker}\` appears before the main() declaration`);
        }
    });
}

// ---------------------------------------------------------------------------
// Runtime harness: a TCP listener that counts (and immediately drops) every
// connection, plus a child-process importer with a scrubbed environment.
// ---------------------------------------------------------------------------

let server: net.Server;
let port = 0;
let connections = 0;
let emptyCwd: string;
let importer: string;

before(async () => {
    server = net.createServer((socket) => {
        connections += 1;
        socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as net.AddressInfo).port;
    // An empty cwd so the `resolveDatabaseUrl()` helpers cannot find a real
    // `.env` / `.env.local` by relative path either.
    emptyCwd = mkdtempSync(path.join(os.tmpdir(), "apply-inert-"));
    // A real entrypoint file, so process.argv[1] is truthy in the child and the
    // guard's URL comparison actually runs (with `node -e` argv[1] is undefined
    // and every guard would short-circuit on its first operand).
    importer = path.join(emptyCwd, "importer.mjs");
    writeFileSync(importer, `await import(process.argv[2]);\n`);
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(emptyCwd, { recursive: true, force: true });
});

function scrubbedEnv(): Record<string, string> {
    // Deliberately NOT `...process.env`: a developer shell here usually carries
    // the real DATABASE_URL. Keep only what Node and the Prisma engine need to
    // start on Windows/Linux, then point every DB variable at our listener.
    const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "COMSPEC", "PATHEXT", "windir"];
    const env: Record<string, string> = {};
    for (const key of keep) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
    }
    const stub = `postgresql://inert:inert@127.0.0.1:${port}/inert?connect_timeout=2`;
    env.DATABASE_URL = stub;
    env.DIRECT_URL = stub;
    env.NO_COLOR = "1";
    return env;
}

type RunResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function runNode(args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd, env: scrubbedEnv() as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] as const });
        let stdout = "";
        let stderr = "";
        child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
        child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`child did not exit within ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, timeoutMs);
        child.on("error", (e: Error) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

async function settle<T>(p: Promise<T>): Promise<T> {
    const result = await p;
    // The child has exited, so any TCP connect it made has already reached the
    // OS accept queue; yield a couple of ticks so `connection` events land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return result;
}

const importInChild = (fileUrl: string) => settle(runNode([importer, fileUrl], emptyCwd, 60_000));
const runDirectly = (file: string) => settle(runNode([file], emptyCwd, 60_000));

test("harness control: a module-scope Prisma query IS caught by the listener", async () => {
    const before = connections;
    const control = path.join(emptyCwd, "control-module-scope-query.mjs");
    writeFileSync(
        control,
        [
            `import { createRequire } from "node:module";`,
            `const require = createRequire(${JSON.stringify(pathToFileURL(path.join(root, "package.json")).href)});`,
            `const { PrismaClient } = require("@prisma/client");`,
            `const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });`,
            `try { await prisma.$executeRawUnsafe("SELECT 1"); } finally { await prisma.$disconnect(); }`,
            ``,
        ].join("\n"),
    );
    const result = await importInChild(pathToFileURL(control).href);
    const seen = connections - before;
    assert.ok(seen > 0, `control connected ${seen} times — the listener is not observing Prisma\nstderr:\n${result.stderr}`);
    assert.notEqual(result.code, 0, "control should fail against a socket that drops the handshake");
});

test("harness control: a guarded script runs when executed directly and not when imported", async () => {
    const control = path.join(emptyCwd, "control-guarded.mjs");
    writeFileSync(
        control,
        [
            URL_IMPORT,
            `async function main() { console.log("MAIN_RAN"); }`,
            GUARD_LINE,
            `if (isMainModule) { await main(); }`,
            ``,
        ].join("\n"),
    );
    const direct = await runDirectly(control);
    assert.equal(direct.code, 0, direct.stderr);
    assert.match(direct.stdout, /MAIN_RAN/, "guard did not fire for direct execution");
    const imported = await importInChild(pathToFileURL(control).href);
    assert.equal(imported.code, 0, imported.stderr);
    assert.doesNotMatch(imported.stdout, /MAIN_RAN/, "guard let main() run on import");
});

for (const name of scripts) {
    test(`runtime: importing scripts/${name} opens no DB connection and exits 0`, async () => {
        // Preflight: never spawn a script whose source check failed — a regressed script could load
        // a real .env at module scope, and this harness must not be the thing that runs it.
        const problems = sourceProblems.get(name)!;
        assert.deepEqual(problems, [], `${name} failed the source check; refusing to import it:\n  ${problems.join("\n  ")}`);

        const before = connections;
        const result = await importInChild(pathToFileURL(path.join(scriptsDir, name)).href);
        const seen = connections - before;
        const dump = `exit=${result.code} signal=${result.signal} connections=${seen}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
        assert.equal(seen, 0, `import attempted ${seen} DB connection(s)\n${dump}`);
        assert.equal(result.code, 0, `import did not exit cleanly\n${dump}`);
        assert.doesNotMatch(
            result.stdout + result.stderr,
            /applied|\bok\b|verified|Migration failed|Refusing|DATABASE_URL/i,
            `import produced migration-style output\n${dump}`,
        );
    });
}
