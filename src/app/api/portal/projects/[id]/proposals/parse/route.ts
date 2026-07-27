import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveSessionClientId } from "@/lib/portal-auth";
import { parseProductUrl } from "@/lib/product-parse";
import { getPortalVisibility } from "@/lib/actions";

export const maxDuration = 30;

// POST: portal-client product URL parse, used to prefill the "suggest an item"
// form. Price is stripped from the response — it's PM-side info until the
// proposal is approved. (submitSelectionProposal re-parses server-side and
// persists price on the SelectionProposal row; this route never persists.)
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
    try {
        const { id: projectId } = await props.params;

        // Same order as the portal selections page and /api/portal/files:
        // visibility gate first, applied uniformly (no staff bypass) — this
        // route only exists to prefill the "suggest an item" form, which is
        // itself gated on showSelections.
        const visibility = await getPortalVisibility(projectId);
        if (!visibility.isPortalEnabled || !visibility.showSelections) {
            return NextResponse.json({ error: "Not found" }, { status: 404 });
        }

        const staffSession = await getServerSession(authOptions);
        const isStaff = ["ADMIN", "MANAGER"].includes((staffSession?.user as any)?.role);

        if (!isStaff) {
            const sessionClientId = await resolveSessionClientId();
            if (!sessionClientId) {
                return NextResponse.json({ error: "Not found" }, { status: 404 });
            }
            const project = await prisma.project.findFirst({
                where: { id: projectId, clientId: sessionClientId },
                select: { id: true },
            });
            if (!project) {
                return NextResponse.json({ error: "Not found" }, { status: 404 });
            }
        }

        const body = await req.json().catch(() => null);
        const url = typeof body?.url === "string" ? body.url.trim() : "";
        if (!url) {
            return NextResponse.json({ error: "url required" }, { status: 400 });
        }

        const parsed = await parseProductUrl(url);
        const { price, ...withoutPrice } = parsed;
        return NextResponse.json(withoutPrice);
    } catch (err: any) {
        console.error("POST /api/portal/projects/[id]/proposals/parse error:", err);
        return NextResponse.json({ error: err.message || "Parse failed" }, { status: 500 });
    }
}
