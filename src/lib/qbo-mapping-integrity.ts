export const QBO_AMOUNT_TOLERANCE = 0.005;

export type QboMappingIdentityIssue =
    | { kind: "duplicate_qbo_mapping"; detail: { mappingCount: number } }
    | { kind: "realm_mismatch"; detail: { binding: "unbound" | "different" } };

/**
 * Fail-closed identity gate shared by every path that can turn a QBO state
 * change into a ProBuild settlement. QBO entity IDs are unique only inside a
 * company realm, and a duplicated local mapping is never safe to guess through.
 */
export function validateQboMappingIdentity(input: {
    mappingCount: number;
    boundRealmId: string | null;
    activeRealmId: string;
}): QboMappingIdentityIssue | null {
    if (input.mappingCount !== 1) {
        return { kind: "duplicate_qbo_mapping", detail: { mappingCount: input.mappingCount } };
    }
    if (input.boundRealmId !== input.activeRealmId) {
        return {
            kind: "realm_mismatch",
            detail: { binding: input.boundRealmId ? "different" : "unbound" },
        };
    }
    return null;
}

export function qboAmountsMatch(probuildAmount: number, qboTotal: number) {
    return Math.abs(probuildAmount - qboTotal) <= QBO_AMOUNT_TOLERANCE;
}
