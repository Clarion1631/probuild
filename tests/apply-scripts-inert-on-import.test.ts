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
 *     BEFORE any child process is spawned): no dotenv `config(...)`,
 *     `new PrismaClient(...)`, raw-SQL call, `require(...)`, dynamic
 *     `import(...)`, top-level `await`, or `process.exit(...)` may appear at
 *     module scope — outside a real function body (an IIFE does not count) or
 *     the guard's own `if` branch. The guard must be exactly
 *     `const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href`
 *     (or the older `fileURLToPath(import.meta.url) === process.argv[1]` form),
 *     used as `if (isMainModule) { ...main()... }` with no `else`, and `main()`
 *     may be called nowhere else.
 *
 *  2. Runtime: each script is imported in a child process whose environment
 *     holds only a DATABASE_URL / DIRECT_URL pointing at a TCP listener owned by
 *     this test. The import must exit 0, print nothing that looks like a
 *     migration log, and the listener must see ZERO connections. A positive
 *     control proves the listener really does catch a module-scope query.
 *     The source check runs first so a script that regressed to loading a real
 *     `.env` at module scope is never even imported.
 *
 * What this does NOT prove: it detects the specific syntax above plus observed
 * TCP connections. It is not a general side-effect analysis.
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
// Source check (TypeScript AST).
// ---------------------------------------------------------------------------

/** The only accepted guard expressions, whitespace-normalised. */
const GUARD_EXPRESSIONS = new Set([
    "process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href",
    "process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]",
]);

const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

function isFunctionLike(node: ts.Node): boolean {
    return (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessor(node) ||
        ts.isSetAccessor(node) ||
        ts.isConstructorDeclaration(node)
    );
}

/** `(async () => { ... })()` / `(function () { ... })()` — runs at load, so it shields nothing. */
function isImmediatelyInvoked(fn: ts.Node): boolean {
    let n: ts.Node = fn;
    while (n.parent && ts.isParenthesizedExpression(n.parent)) n = n.parent;
    return !!n.parent && ts.isCallExpression(n.parent) && n.parent.expression === n;
}

type SourceReport = { violations: string[]; guardIfs: number; mainCallsInGuard: number; hasGuardConst: boolean; hasMain: boolean };

function analyse(name: string, text: string): SourceReport {
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const report: SourceReport = { violations: [], guardIfs: 0, mainCallsInGuard: 0, hasGuardConst: false, hasMain: false };

    // Module-level `const isMainModule = <exact guard>;`
    for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.name?.text === "main") report.hasMain = true;
        if (!ts.isVariableStatement(st)) continue;
        for (const decl of st.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name) || decl.name.text !== "isMainModule") continue;
            const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
            const init = decl.initializer ? normalise(decl.initializer.getText(sf)) : "";
            if (isConst && GUARD_EXPRESSIONS.has(init)) report.hasGuardConst = true;
            else report.violations.push(`line ${line(st)}: isMainModule must be \`const\` and exactly one of the accepted guard expressions, got: ${init || "(no initializer)"}`);
        }
    }

    /** The guard: a module-level `if (isMainModule) { ... }` with no else. Returns its then-branch. */
    function guardBranch(node: ts.Node): ts.Node | null {
        if (!ts.isIfStatement(node) || node.parent !== sf) return null;
        if (!ts.isIdentifier(node.expression) || node.expression.text !== "isMainModule") return null;
        report.guardIfs += 1;
        if (node.elseStatement) report.violations.push(`line ${line(node)}: the main-module guard must not have an else branch`);
        return node.thenStatement;
    }

    function visit(node: ts.Node, shielded: boolean, inGuard: boolean) {
        const branch = guardBranch(node);
        if (branch) {
            // Only the then-branch is shielded; the condition itself is checked above.
            ts.forEachChild(node, (child) => visit(child, child === branch, child === branch));
            return;
        }
        const realFunction = isFunctionLike(node) && !isImmediatelyInvoked(node);
        const nowShielded = shielded || realFunction;

        if (ts.isCallExpression(node) && node.expression.getText(sf) === "main") {
            if (inGuard) report.mainCallsInGuard += 1;
            else report.violations.push(`line ${line(node)}: main() called outside the main-module guard`);
        }

        if (!nowShielded) {
            if (ts.isAwaitExpression(node)) {
                report.violations.push(`line ${line(node)}: top-level await`);
            }
            if (ts.isNewExpression(node) && node.expression.getText(sf) === "PrismaClient") {
                report.violations.push(`line ${line(node)}: new PrismaClient(...) at module scope`);
            }
            if (ts.isCallExpression(node)) {
                const callee = node.expression.getText(sf);
                if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                    report.violations.push(`line ${line(node)}: dynamic import() at module scope`);
                }
                if (/^(?:dotenv\.)?config$/.test(callee)) {
                    report.violations.push(`line ${line(node)}: dotenv config(...) at module scope`);
                }
                if (/(?:^|\.)\$(?:executeRaw|queryRaw|transaction|connect)(?:Unsafe)?$/.test(callee)) {
                    report.violations.push(`line ${line(node)}: ${callee}(...) at module scope`);
                }
                if (callee === "process.exit") {
                    report.violations.push(`line ${line(node)}: process.exit(...) at module scope`);
                }
                if (callee === "require") {
                    report.violations.push(`line ${line(node)}: require(...) at module scope`);
                }
            }
        }

        // A function declared inside the guard branch is not "the guard" for counting main() calls.
        ts.forEachChild(node, (child) => visit(child, nowShielded, inGuard && !realFunction));
    }

    visit(sf, false, false);
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

test("harness control: the source check rejects the incident shape and the known evasions", () => {
    const guard = `const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;`;
    const cases: Record<string, string> = {
        incident: `import { config } from "dotenv"; import { PrismaClient } from "@prisma/client";
config({ path: ".env.production.local" });
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe("ALTER TABLE x ADD COLUMN y TEXT");`,
        iife: `import { PrismaClient } from "@prisma/client";
(async () => { const p = new PrismaClient(); await p.$executeRawUnsafe("x"); })();
async function main() {}
${guard}
if (isMainModule) { await main(); }`,
        inverted: `async function main() {}
${guard}
if (!isMainModule) { await main(); }`,
        elseBranch: `async function main() {}
${guard}
if (isMainModule) { await main(); } else { await main(); }`,
        emptyGuard: `async function main() {}
${guard}
if (isMainModule) {}`,
        looseGuard: `async function main() {}
const isMainModule = true;
if (isMainModule) { await main(); }`,
        voidMain: `async function main() {}
void main();
${guard}
if (isMainModule) { await main(); }`,
        dynamicImport: `async function main() {}
import("./apply-other.mjs");
${guard}
if (isMainModule) { await main(); }`,
        chainOutside: `async function main() {}
main().catch(console.error);
${guard}
if (isMainModule) {}`,
    };
    for (const [label, src] of Object.entries(cases)) {
        const problems = problemsOf(analyse(label, src));
        assert.ok(problems.length > 0, `source check did not reject the "${label}" shape`);
    }
    const good = `import { PrismaClient } from "@prisma/client"; import { pathToFileURL } from "node:url";
const statements = ["SELECT 1"];
function resolveDatabaseUrl() { return process.env.DATABASE_URL; }
async function main() { const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } }); try { for (const s of statements) await prisma.$executeRawUnsafe(s); } finally { await prisma.$disconnect(); } }
${guard}
if (isMainModule) { await main(); }`;
    assert.deepEqual(problemsOf(analyse("good", good)), [], "source check rejected the canonical good shape");
    const goodChain = `import { PrismaClient } from "@prisma/client"; import { pathToFileURL } from "node:url";
let prisma;
async function main() { prisma = new PrismaClient(); await prisma.$executeRawUnsafe("SELECT 1"); }
${guard}
if (isMainModule) { main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma?.$disconnect()); }`;
    assert.deepEqual(problemsOf(analyse("goodChain", goodChain)), [], "source check rejected the catch/finally chain shape");
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

async function importInChild(fileUrl: string): Promise<RunResult> {
    const result = await runNode(
        ["--input-type=module", "-e", `await import(${JSON.stringify(fileUrl)});`],
        emptyCwd,
        60_000,
    );
    // The child has exited, so any TCP connect it made has already reached the
    // OS accept queue; yield a couple of ticks so `connection` events land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return result;
}

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
