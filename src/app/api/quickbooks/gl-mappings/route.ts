import { NextRequest, NextResponse } from "next/server";
import { saveQBSettings } from "@/lib/integration-store";
import { requireIntegrationAccess, validateStringMap } from "@/lib/integration-access";

/**
 * Writes the cost-code -> QuickBooks GL account map.
 *
 * This had NO role check: the proxy proves a signed-in staff session and
 * nothing more, so any active account - FIELD_CREW included - could POST a
 * whole new map and silently re-file every synced invoice line into an account
 * of their choosing (review round 10). Gated on ADMIN or financialReports, the
 * same expression the Gusto mapping endpoint and the payroll export use.
 *
 * And the body is validated as a bounded PLAIN object. The old check was
 * `typeof glMappings !== "object"`, which is false for `null` (so a null wiped
 * the map), false for every array, and false for a body carrying __proto__ -
 * see validateStringMap.
 */
export async function POST(req: NextRequest) {
    const gate = await requireIntegrationAccess();
    if ("response" in gate) return gate.response;

    try {
        const { glMappings } = await req.json();
        const validated = validateStringMap(glMappings, "glMappings");
        if (!validated.ok) {
            return NextResponse.json({ error: validated.error }, { status: 400 });
        }
        // saveQBSettings THROWS if it could not persist — same reasoning as the
        // Gusto mapping endpoint: a suppressed database error used to be
        // reported to the caller as a successful save.
        await saveQBSettings({ glMappings: validated.map });
        return NextResponse.json({ success: true });
    } catch (err) {
        console.error("POST /api/quickbooks/gl-mappings failed:", err);
        return NextResponse.json(
            { error: "Could not save the QuickBooks GL mappings. Nothing was changed - try again." },
            { status: 500 }
        );
    }
}
