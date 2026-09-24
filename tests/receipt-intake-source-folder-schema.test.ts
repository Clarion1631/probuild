import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMigrationTarget, statements } from '../scripts/apply-receipt-intake-source-folder.mjs';

test('schema migration requires explicit expected URL host/db and yes', () => {
    const url = 'postgresql://test:test@db.example.test:6543/example?pgbouncer=true';
    assert.throws(() => validateMigrationTarget(url, []));
    assert.throws(() => validateMigrationTarget(url, ['--target', 'ci', '--yes', '--expect-db', 'example', '--expect-host', 'wrong.example.test']));
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
