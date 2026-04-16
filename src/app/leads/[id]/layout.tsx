import { getSessionOrDev } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { notFound, redirect } from "next/navigation";

/**
 * Row-level auth gate for all /leads/[id]/* routes.
 *
 * Before this file existed, any authenticated user could load any lead by
 * guessing or scraping its id — every nested page (contracts, estimates,
 * files, notes, activity, etc.) skipped permission checks entirely. That is
 * IDOR #1 in the peer review.
 *
 * The project side enforces row-level access via `ProjectAccess`. Leads do
 * not have an equivalent per-lead access table, so we gate on the coarser
 * `leadAccess` permission key (see src/lib/permissions.ts). ADMIN and
 * MANAGER always pass; FIELD_CREW / FINANCE / EMPLOYEE fall through to
 * `getDefaultPermission`, none of which grant leadAccess by default.
 *
 * If and when a per-lead access model is introduced, that check lives here.
 */
export default async function LeadLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;

    const session = await getSessionOrDev();
    if (!session?.user?.email) redirect("/login");

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        include: { permissions: true },
    });

    // Mirrors the project layout dev fallback so local development without
    // a real user row in the DB still works.
    if (!user && process.env.NODE_ENV !== "development") redirect("/login");
    const effectiveUser = user ?? { role: "ADMIN", permissions: null };

    if (!hasPermission(effectiveUser, "leadAccess")) {
        redirect("/projects");
    }

    // Verify the lead exists. Any viewer with leadAccess is authorized to
    // know whether a lead exists, so this is a 404 (not a redirect) to
    // match the project layout's `getProject` + `notFound()` pattern.
    const lead = await prisma.lead.findUnique({
        where: { id },
        select: { id: true },
    });
    if (!lead) notFound();

    return <>{children}</>;
}
