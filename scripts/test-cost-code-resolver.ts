import assert from "node:assert/strict";
import {
    resolveCostCode,
    type CostCodeLookup,
} from "@/lib/cost-code-resolver";

type CostCode = { id: string; isActive: boolean } | null;
type LineItem = {
    costCodeId: string | null;
    costTypeId: string | null;
    costCode: { isActive: boolean } | null;
} | null;

function lookup(costCode: CostCode, lineItem: LineItem): CostCodeLookup {
    return {
        costCode: {
            findUnique: async () => costCode,
        },
        estimateItem: {
            findUnique: async () => lineItem,
        },
    };
}

async function expectResolution(
    name: string,
    input: { costCodeId?: string | null; lineItemId?: string | null },
    db: CostCodeLookup,
    expected: Awaited<ReturnType<typeof resolveCostCode>>
) {
    assert.deepEqual(await resolveCostCode(input, db), expected, name);
}

async function main() {
    await expectResolution(
        "accepts an explicit active cost code",
        { costCodeId: "cc-active" },
        lookup({ id: "cc-active", isActive: true }, null),
        { ok: true, costCodeId: "cc-active", costTypeId: null }
    );

    await expectResolution(
        "uses an explicit cost code before a line item",
        { costCodeId: "cc-explicit", lineItemId: "item-must-not-be-read" },
        {
            costCode: {
                findUnique: async () => ({ id: "cc-explicit", isActive: true }),
            },
            estimateItem: {
                findUnique: async () => {
                    throw new Error("The line item must not be read when costCodeId is supplied.");
                },
            },
        },
        { ok: true, costCodeId: "cc-explicit", costTypeId: null }
    );

    await expectResolution(
        "rejects a missing explicit cost code",
        { costCodeId: "missing" },
        lookup(null, null),
        { ok: false, status: 400, error: "Cost code not found." }
    );

    await expectResolution(
        "rejects an inactive explicit cost code",
        { costCodeId: "cc-inactive" },
        lookup({ id: "cc-inactive", isActive: false }, null),
        { ok: false, status: 400, error: "That cost code is inactive." }
    );

    await expectResolution(
        "derives a code and type from an active line item",
        { lineItemId: "item-active" },
        lookup(null, {
            costCodeId: "cc-derived",
            costTypeId: "ct-labor",
            costCode: { isActive: true },
        }),
        { ok: true, costCodeId: "cc-derived", costTypeId: "ct-labor" }
    );

    await expectResolution(
        "rejects a missing line item",
        { lineItemId: "missing" },
        lookup(null, null),
        { ok: false, status: 400, error: "Line item not found." }
    );

    await expectResolution(
        "rejects a line item without a cost code",
        { lineItemId: "item-uncoded" },
        lookup(null, { costCodeId: null, costTypeId: null, costCode: null }),
        {
            ok: false,
            status: 400,
            error:
                "This line item isn't linked to a cost code. Pick a coded line item, or set its cost code on the estimate first.",
        }
    );

    await expectResolution(
        "rejects a line item with an inactive cost code",
        { lineItemId: "item-inactive" },
        lookup(null, {
            costCodeId: "cc-inactive",
            costTypeId: null,
            costCode: { isActive: false },
        }),
        { ok: false, status: 400, error: "This line item's cost code is inactive." }
    );

    await expectResolution(
        "requires an explicit code or coded line item",
        {},
        lookup(null, null),
        {
            ok: false,
            status: 400,
            error:
                "A cost code is required so this can post to the job. Select a cost code or a coded line item.",
        }
    );

    console.log("PASS: cost-code resolver behavior is preserved (9 cases)");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
