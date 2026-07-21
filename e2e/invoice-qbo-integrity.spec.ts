import { expect, test } from "@playwright/test";
import {
    QBO_AMOUNT_TOLERANCE,
    qboAmountsMatch,
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
});
