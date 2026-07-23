import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    QBO_AMOUNT_TOLERANCE,
    qboAmountsMatch,
    qboRealmMatches,
    validateQboMappingIdentity,
} from "../src/lib/qbo-mapping-integrity";

test.describe("QBO mapping integrity gate", () => {
    test("requires exactly one realm-bound mapping", () => {
        expect(validateQboMappingIdentity({ mappingCount: 2, boundRealmId: "realm-a", activeRealmId: "realm-a" }))
            .toEqual({ kind: "duplicate_qbo_mapping", detail: { mappingCount: 2 } });
        expect(validateQboMappingIdentity({ mappingCount: 1, boundRealmId: null, activeRealmId: "realm-a" }))
            .toEqual({ kind: "realm_mismatch", detail: { binding: "unbound" } });
        expect(validateQboMappingIdentity({ mappingCount: 1, boundRealmId: "realm-b", activeRealmId: "realm-a" }))
            .toEqual({ kind: "realm_mismatch", detail: { binding: "different" } });
        expect(validateQboMappingIdentity({ mappingCount: 0, boundRealmId: "realm-b", activeRealmId: "realm-a" }))
            .toEqual({ kind: "realm_mismatch", detail: { binding: "different" } });
        expect(validateQboMappingIdentity({ mappingCount: 1, boundRealmId: "realm-a", activeRealmId: "realm-a" }))
            .toBeNull();
    });

    test("uses a cent-exact half-cent tolerance on money paths", () => {
        expect(QBO_AMOUNT_TOLERANCE).toBe(0.005);
        expect(qboAmountsMatch(100, 100.005)).toBe(true);
        expect(qboAmountsMatch(100, 100.006)).toBe(false);
    });

    test("destructive QBO writes require an exact non-null realm binding", () => {
        expect(qboRealmMatches("realm-a", "realm-a")).toBe(true);
        expect(qboRealmMatches("realm-b", "realm-a")).toBe(false);
        expect(qboRealmMatches(null, "realm-a")).toBe(false);

        const actions = readFileSync(resolve(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
        expect(actions).toContain("qboRealmMatches(schedule.qbRealmId, tokens.realmId)");
        // The unlink claim moved into the shared realm-aware helper — the caller
        // must pass the realm it read, and the helper must pin + clear it.
        expect(actions).toContain("claimQBInvoiceUnlink(tx, schedule.id, schedule.qbInvoiceId!, schedule.qbRealmId)");
        const qbPayments = readFileSync(resolve(__dirname, "..", "src", "lib", "quickbooks-payments.ts"), "utf8");
        expect(qbPayments).toContain("qbRealmId: expectedQbRealmId");
        expect(qbPayments).toContain("expectedQbRealmId: string | null");
    });
});
