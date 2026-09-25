import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { validateMigrationTarget, statements } from '../scripts/apply-receipt-intake-source-folder.mjs';
import { assertCiDatabaseTarget, EXPECTED_CI_DATABASE } from '../scripts/ci-receipt-intake-source-folder-column.mjs';

const ROOT = path.join(__dirname, '..');

test('schema migration requires explicit expected URL host/db and yes', () => {
    const url = 'postgresql://test:test@db.example.test:6543/example?pgbouncer=true';
    assert.throws(() => validateMigrationTarget(url, []));
    assert.throws(() => validateMigrationTarget(url, ['--target', 'ci', '--yes', '--expect-db', 'example', '--expect-host', 'wrong.example.test']));
    assert.throws(
        () => validateMigrationTarget(url, ['--target', 'ci', '--yes', '--expect-db', 'wrong-db', '--expect-host', 'db.example.test']),
        'a database name that does not match --expect-db must refuse',
    );
    assert.throws(
        () => validateMigrationTarget(
            'postgresql://test:test@db.example.test:6543/example',
            ['--target', 'ci', '--yes', '--expect-db', 'example', '--expect-host', 'db.example.test'],
        ),
        'a URL without ?pgbouncer=true must refuse (CLAUDE.md: without it, 42P05 and the site goes down)',
    );
    assert.doesNotThrow(() => validateMigrationTarget(url, ['--target', 'ci', '--yes', '--expect-db', 'example', '--expect-host', 'db.example.test']));
});

test('DDL is additive: one nullable TEXT column, nothing destructive', () => {
    assert.deepEqual(statements, ['ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "sourceFolder" TEXT']);
    const sql = statements.join('\n');
    assert.doesNotMatch(sql, /DROP|DELETE|UPDATE|ALTER COLUMN/i);
});

test('the committed migration.sql is exactly the one statement', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(
        new URL('../prisma/migrations/20260925000000_receipt_intake_source_folder/migration.sql', import.meta.url),
        'utf8',
    );
    assert.equal(sql.trim().replace(/;$/, ''), statements[0]);
});

test('the new migration is parked for the whole Phase 1 harness run', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../scripts/ci-apply-receipt-intake-e2e.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('const PHASE1_DEPENDENT_MIGRATIONS = [');
    assert.ok(start >= 0, 'ci-apply-receipt-intake-e2e.mjs must declare PHASE1_DEPENDENT_MIGRATIONS');
    const array = source.slice(start, source.indexOf('];', start));
    assert.ok(
        array.includes('20260925000000_receipt_intake_source_folder'),
        'ALTER TABLE "ReceiptIntake" ADD COLUMN would 42P01 against the Phase 1 harness while ReceiptIntake is parked',
    );
});

test('CI applies the schema, proves it against an ABSENT column, and pins the host var', async () => {
    const { readFileSync } = await import('node:fs');
    const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const start = ci.indexOf('- name: Apply receipt intake source folder schema');
    assert.ok(start >= 0, 'ci.yml must have the "Apply receipt intake source folder schema" step');
    const step = ci.slice(start, ci.indexOf('\n\n', start));
    assert.ok(step.includes('job.services.postgres.id'));
    // Twice, as the memo step does for idempotency -- but this step's drop
    // beforehand also proves the ADD COLUMN branch itself, not just the
    // idempotent no-op every migrate-deploy'd database would otherwise hide.
    const callCount = step.split('apply-receipt-intake-source-folder.mjs').length - 1;
    assert.ok(callCount >= 2, 'the apply script must run at least twice (add, then no-op)');
    assert.ok(step.includes('--expect-host "$FOLDER_DB_HOST"'));
    assert.match(step, /DROP COLUMN IF EXISTS "sourceFolder"|ci-receipt-intake-source-folder-column\.mjs drop/);
    // The drop has to run BEFORE the first apply, not just exist somewhere in
    // the step -- otherwise it proves nothing about the ADD COLUMN branch
    // against a database that never had the column (a migrate-deploy'd one
    // always already has it, which would hide the branch behind a no-op).
    const dropIndex = step.search(/DROP COLUMN IF EXISTS "sourceFolder"|ci-receipt-intake-source-folder-column\.mjs drop/);
    const firstApplyIndex = step.indexOf('apply-receipt-intake-source-folder.mjs');
    assert.ok(dropIndex >= 0 && firstApplyIndex >= 0);
    assert.ok(dropIndex < firstApplyIndex, 'the drop must run before the first apply call');
});

test('ci-receipt-intake-source-folder-column.mjs refuses a Supabase-looking host (DANGER: it runs a raw DROP COLUMN)', () => {
    assert.equal(EXPECTED_CI_DATABASE, 'probuild_migrations');
    assert.throws(
        () => assertCiDatabaseTarget('postgresql://postgres.abc123:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true'),
        /REFUSING/,
        'a pooler.supabase.com host must be refused',
    );
    assert.throws(
        () => assertCiDatabaseTarget('postgresql://test:test@db.example.supabase.co:5432/probuild_migrations'),
        /REFUSING/,
        'a supabase.co host must be refused',
    );
});

test('ci-receipt-intake-source-folder-column.mjs refuses any database name other than the CI one', () => {
    assert.throws(
        () => assertCiDatabaseTarget('postgresql://probuild:probuild@localhost:5432/postgres'),
        /REFUSING/,
        'the CI harness never touches the bare "postgres" database',
    );
    assert.throws(
        () => assertCiDatabaseTarget('postgresql://probuild:probuild@localhost:5432/probuild_apply_fresh'),
        /REFUSING/,
        'a different throwaway db name must still be refused -- only the exact CI db name is accepted',
    );
    assert.doesNotThrow(
        () => assertCiDatabaseTarget('postgresql://probuild:probuild@localhost:5432/probuild_migrations?pgbouncer=true'),
        'the real CI DATABASE_URL from ci.yml must be accepted',
    );
});

test('ci-receipt-intake-source-folder-column.mjs refuses a missing or unparseable DATABASE_URL', () => {
    assert.throws(() => assertCiDatabaseTarget(undefined));
    assert.throws(() => assertCiDatabaseTarget(''));
    assert.throws(() => assertCiDatabaseTarget('not a url'));
});

test('ci-receipt-intake-source-folder-column.mjs the real drop command refuses a bad DATABASE_URL before touching @prisma/client (checker, PR #555 round 3, mutation proof)', () => {
    // tests/receipt-intake-source-folder-schema.test.ts only ever exercised
    // assertCiDatabaseTarget as a pure function, imported straight from the
    // module -- so a mutation deleting its call site inside main() (the real
    // guard on the raw DROP COLUMN) still left every test in this file
    // passing 9/9. This spawns the actual script the way CI does, so the
    // guard has to run for real. It is safe: the refusal happens before
    // `@prisma/client` is ever imported, so nothing dials a database, even
    // for the unreachable 127.0.0.1:1 case below (proven by hand first).
    const run = (databaseUrl: string) => {
        try {
            const stdout = execFileSync(
                process.execPath,
                ['scripts/ci-receipt-intake-source-folder-column.mjs', 'drop'],
                { cwd: ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
            );
            return { code: 0, stdout, stderr: '' };
        } catch (error) {
            const failure = error as { status?: number; stdout?: string; stderr?: string };
            return { code: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
        }
    };

    const supabaseHost = run('postgresql://u:p@fake.supabase.co.invalid:5432/probuild_migrations');
    assert.equal(supabaseHost.code, 1, 'a Supabase-looking host must exit 1, not run the drop');
    assert.match(supabaseHost.stderr, /REFUSING/);

    const wrongDb = run('postgresql://u:p@127.0.0.1:1/postgres');
    assert.equal(wrongDb.code, 1, 'the wrong database name must exit 1, not attempt to connect to port 1');
    assert.match(wrongDb.stderr, /REFUSING/);
});

test('schema.prisma declares the nullable column on ReceiptIntake', async () => {
    const { readFileSync } = await import('node:fs');
    const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    const modelStart = schema.indexOf('model ReceiptIntake {');
    assert.ok(modelStart >= 0);
    const modelEnd = schema.indexOf('\n}', modelStart);
    const model = schema.slice(modelStart, modelEnd);
    assert.match(model, /sourceFolder\s+String\?/);
});
