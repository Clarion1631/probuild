import assert from "node:assert/strict";
import test from "node:test";

import {
    applyProjectProjectionSchema,
    statements,
} from "../scripts/apply-project-projection-schema.mjs";

test("project projection DDL applies only guarded nullable columns", async () => {
    const executed: string[] = [];
    await applyProjectProjectionSchema({
        $executeRawUnsafe: async (sql: string) => {
            executed.push(sql);
        },
    });

    assert.deepEqual(executed, statements);
    assert.equal(executed.length, 1);
    assert.match(executed[0], /ADD COLUMN IF NOT EXISTS "projectedEndDate" TIMESTAMP\(3\)/);
    assert.match(executed[0], /ADD COLUMN IF NOT EXISTS "projectedEndComputedAt" TIMESTAMP\(3\)/);
    assert.doesNotMatch(executed[0], /\b(?:DROP|DELETE|NOT NULL|DEFAULT)\b/i);
});
