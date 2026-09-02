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
 *  1. Runtime: each script is imported in a child process whose environment
 *     holds only a DATABASE_URL / DIRECT_URL pointing at a TCP listener owned by
 *     this test. The import must exit 0, print nothing that looks like a
 *     migration log, and the listener must see ZERO connections. A positive
 *     control proves the listener really does catch a module-scope query.
 *
 *  2. Source: the script is parsed with the TypeScript AST and no dotenv
 *     `config(...)`, `new PrismaClient(...)`, raw-SQL call, top-level `await`,
 *     or `process.exit(...)` may appear at module scope — i.e. before `main()`
 *     runs — outside a function body or the main-module guard block. `main()`
 *     itself may only be called from inside that guard.
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
    assert.ok(
        seen > 0 || result.code !== 0,
        `control did not trip the harness: connections=${seen} exit=${result.code}\nstderr:\n${result.stderr}`,
    );
    assert.ok(seen > 0, `control connected ${seen} times — the listener is not observing Prisma`);
    assert.notEqual(result.code, 0, "control should fail against a socket that drops the handshake");
});

for (const name of scripts) {
    test(`runtime: importing scripts/${name} opens no DB connection and exits 0`, async () => {
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

// ---------------------------------------------------------------------------
// Source check (TypeScript AST). Nothing that loads env, builds a client, runs
// SQL, awaits, or exits may sit at module scope; main() is only called inside
// the main-module guard.
// ---------------------------------------------------------------------------

const GUARD_RE = /import\.meta\.url\s*===\s*pathToFileURL\(process\.argv\[1\]\)\.href|fileURLToPath\(import\.meta\.url\)\s*===\s*process\.argv\[1\]/;

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

function isMainModuleGuard(node: ts.Node, sf: ts.SourceFile): boolean {
    if (!ts.isIfStatement(node)) return false;
    const cond = node.expression.getText(sf);
    return /isMainModule/.test(cond) || GUARD_RE.test(cond);
}

/** Walk the file; report offending nodes that are neither inside a function nor inside the guard block. */
function moduleScopeViolations(sf: ts.SourceFile): string[] {
    const violations: string[] = [];
    const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

    function visit(node: ts.Node, shielded: boolean) {
        const nowShielded = shielded || isFunctionLike(node) || isMainModuleGuard(node, sf);

        if (!nowShielded) {
            if (ts.isAwaitExpression(node)) {
                violations.push(`line ${line(node)}: top-level await`);
            }
            if (ts.isNewExpression(node) && /^PrismaClient$/.test(node.expression.getText(sf))) {
                violations.push(`line ${line(node)}: new PrismaClient(...) at module scope`);
            }
            if (ts.isCallExpression(node)) {
                const callee = node.expression.getText(sf);
                if (/^(?:dotenv\.)?config$/.test(callee)) {
                    violations.push(`line ${line(node)}: dotenv config(...) at module scope`);
                }
                if (/(?:^|\.)\$(?:executeRaw|queryRaw|transaction|connect)(?:Unsafe)?$/.test(callee)) {
                    violations.push(`line ${line(node)}: ${callee}(...) at module scope`);
                }
                if (/^process\.exit$/.test(callee)) {
                    violations.push(`line ${line(node)}: process.exit(...) at module scope`);
                }
                if (/^main$/.test(callee)) {
                    violations.push(`line ${line(node)}: main() called outside the main-module guard`);
                }
            }
        }

        ts.forEachChild(node, (child) => visit(child, nowShielded));
    }

    visit(sf, false);
    return violations;
}

for (const name of scripts) {
    test(`source: scripts/${name} has no side effects before main() and guards its entrypoint`, () => {
        const file = path.join(scriptsDir, name);
        const text = readFileSync(file, "utf8");
        const sf = ts.createSourceFile(name, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

        const hasMain = sf.statements.some(
            (s) => ts.isFunctionDeclaration(s) && s.name?.text === "main",
        );
        assert.ok(hasMain, `${name}: no \`function main()\` declaration`);
        assert.match(text, GUARD_RE, `${name}: missing the import.meta.url === pathToFileURL(process.argv[1]).href guard`);

        const guardCalls = (text.match(/\bmain\(\)/g) ?? []).length;
        assert.ok(guardCalls >= 1, `${name}: main() is never invoked`);

        const violations = moduleScopeViolations(sf);
        assert.deepEqual(violations, [], `${name}:\n  ${violations.join("\n  ")}`);

        // Belt and braces for the literal incident shape, on comment-stripped
        // text: nothing that loads env, builds a client, or runs DDL may appear
        // textually before the main() declaration.
        const stripped = text
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .split(/\r?\n/)
            .filter((l) => !l.trim().startsWith("//"))
            .join("\n");
        const mainIdx = stripped.search(/(?:async\s+)?function\s+main\s*\(/);
        assert.ok(mainIdx >= 0, `${name}: main() declaration not found in stripped source`);
        const beforeMain = stripped.slice(0, mainIdx);
        for (const marker of ["config({ path:", "config({path:", "new PrismaClient(", "$executeRawUnsafe"]) {
            assert.ok(
                !beforeMain.includes(marker),
                `${name}: \`${marker}\` appears before the main() declaration`,
            );
        }
    });
}
