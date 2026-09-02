import { NextRequest, NextResponse } from "next/server";
import { saveGustoSettings } from "@/lib/integration-store";
import { requireGustoAccess, validateEmployeeMappings } from "@/lib/gusto-access";

/**
 * Writes the ProBuild-user -> Gusto-employee map.
 *
 * This had NO role check: any signed-in account could rewrite the map that
 * decides whose hours are filed under which Gusto employee, and the payroll
 * export consumes it. Gated on ADMIN or financialReports, and the keys are
 * validated against real users so a mapping cannot be planted for an id that
 * does not exist.
 */
export async function POST(req: NextRequest) {
    const gate = await requireGustoAccess();
    if ("response" in gate) return gate.response;

    try {
        const { employeeMappings } = await req.json();
        const validated = await validateEmployeeMappings(employeeMappings);
        if (!validated.ok) {
            return NextResponse.json({ error: validated.error }, { status: 400 });
        }
        await saveGustoSettings({ employeeMappings: validated.mappings });
        return NextResponse.json({ success: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
