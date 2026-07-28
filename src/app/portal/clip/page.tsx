export const dynamic = "force-dynamic";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { resolveSessionClientId } from "@/lib/portal-auth";
import { getPortalVisibility } from "@/lib/actions";
import PortalClipClient from "./PortalClipClient";

// The client-facing clipper capture popup — opened by the per-project
// "ProBuild Clip" bookmarklet on the portal Selections tab (see the "Get the
// Clipper" card in PortalSuggestionsSection.tsx, built via
// buildClipperBookmarklet in src/lib/clipper-bookmarklet.ts). Unlike the team
// clipper (/clip), a clip here lands in the CLIENT's own suggestion queue —
// it calls submitSelectionProposal, not createProductLibraryItem.
//
// Rendering: this route sits under app/portal/layout.tsx like every other
// portal page, so it keeps that layout's thin header (title + user menu) —
// Next.js layouts can't be selectively suppressed for one nested route
// without restructuring the entire portal route tree into route groups, so
// this is the "minimal standalone layout" the spec allows as a fallback to
// /clip's fully bare rendering (AppLayout already treats every
// /portal-prefixed path as public/chrome-free for the OUTER app shell, i.e.
// no sidebar — that part matches /clip exactly).
//
// Auth gate order (matches assertPortalProjectOwnership's convention, and
// the staff-bypass style used by /portal/projects/[id]/page.tsx):
//   1. Portal client session (or staff) — no session/client match redirects
//      to /portal, the same landing/re-auth gate every other portal page
//      falls back to (there is no separate /login route for clients).
//   2. Ownership of ?projectId= — a mismatch renders a friendly "not
//      available" card instead of notFound()/crashing, since this page opens
//      in a small popup window with no nav chrome to escape from.
//   3. Portal visibility (isPortalEnabled + showSelections) — same treatment.
export default async function PortalClipPage(props: {
    searchParams: Promise<{
        projectId?: string;
        url?: string;
        name?: string;
        price?: string;
        currency?: string;
        image?: string;
        vendor?: string;
    }>;
}) {
    const { projectId, url, name, price, currency, image, vendor } = await props.searchParams;

    if (!projectId) {
        return (
            <NotAvailable message="This clip link is missing its project. Try the Clipper button again from your Selections tab." />
        );
    }

    const session = await getServerSession(authOptions);
    const isStaff = ["ADMIN", "MANAGER"].includes((session?.user as any)?.role);

    let projectWhere: { id: string; clientId?: string };
    if (isStaff) {
        projectWhere = { id: projectId };
    } else {
        const clientId = await resolveSessionClientId();
        if (!clientId) redirect("/portal");
        projectWhere = { id: projectId, clientId };
    }

    const project = await prisma.project.findFirst({ where: projectWhere, select: { id: true } });
    if (!project) {
        return <NotAvailable message="We couldn't find that project, or you don't have access to it." />;
    }

    const visibility = await getPortalVisibility(projectId);
    if (!visibility.isPortalEnabled || !visibility.showSelections) {
        return <NotAvailable message="Suggestions aren't available for this project right now." />;
    }

    return (
        <PortalClipClient
            projectId={project.id}
            initialUrl={url || ""}
            initialName={name || ""}
            initialPrice={price || ""}
            initialCurrency={currency || ""}
            initialImage={image || ""}
            initialVendor={vendor || ""}
        />
    );
}

function NotAvailable({ message }: { message: string }) {
    return (
        <div className="flex items-center justify-center min-h-[60vh] p-4">
            <div className="hui-card w-full max-w-sm p-6 text-center">
                <h1 className="text-base font-bold text-hui-textMain">Not available</h1>
                <p className="text-sm text-hui-textMuted mt-1">{message}</p>
            </div>
        </div>
    );
}
