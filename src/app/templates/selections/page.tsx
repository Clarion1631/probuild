import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionOrDev } from "@/lib/auth";
import { getUserWithPermissionsByEmail, isAdminOrManager } from "@/lib/permissions";
import { listDecisionTemplates } from "@/lib/actions";
import DecisionTemplatesManager from "./DecisionTemplatesManager";

export const dynamic = "force-dynamic";

// Decision Templates (Phase 3 —
// docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md) —
// replaces the "Coming Soon" placeholder. Server-gated to ADMIN/MANAGER;
// other staff roles are redirected back to the templates hub (template CRUD
// is the "GTR admin" surface — applying a template to a project is a
// separate, less-restrictive action available on the project's own
// selections page).
export default async function SelectionTemplatesPage() {
    const session = await getSessionOrDev();
    if (!session?.user?.email) return redirect("/login");

    const user = await getUserWithPermissionsByEmail(session.user.email);
    const effectiveUser = user ?? (process.env.NODE_ENV === "development" ? { role: "ADMIN" } : null);
    if (!effectiveUser || !isAdminOrManager(effectiveUser)) {
        return redirect("/templates");
    }

    const templates = await listDecisionTemplates();

    return (
        <>
            <div className="max-w-4xl mx-auto pt-8 px-6">
                <div className="flex items-center gap-2 text-sm text-hui-textMuted">
                    <Link href="/templates" className="hover:text-hui-textMain">Templates</Link>
                    <span>/</span>
                    <span>Selection Templates</span>
                </div>
            </div>
            <DecisionTemplatesManager initialTemplates={JSON.parse(JSON.stringify(templates))} />
        </>
    );
}
