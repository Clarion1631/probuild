import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("privileged migration scripts require injected Supabase credentials", () => {
    const migration = readFileSync(resolve(__dirname, "..", "scripts", "migrate-takeoffs.mjs"), "utf8");
    expect(migration).toContain("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
    expect(migration).not.toMatch(/SUPABASE_SERVICE_KEY\s*\|\|/);
    expect(migration).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
});
