export const dynamic = "force-dynamic";
import { getProjects, getCompanySettings, estimateTotalsComplete } from "@/lib/actions";
import { currentStaffUserOrNull } from "@/lib/permissions";
import ProjectsClient from "./ProjectsClient";

export default async function ProjectsPage() {
    const projects = await getProjects();
    const settings = await getCompanySettings();
    const viewer = await currentStaffUserOrNull();
    const canDeleteProjects = Boolean(viewer && ["ADMIN", "MANAGER"].includes(viewer.role));
    const customStatuses = settings?.projectStatuses ? JSON.parse(settings.projectStatuses) : null;

    // This list is company-wide, but the estimates embedded in each row are
    // scoped to the caller — so the revenue card can be a partial sum sitting
    // next to a company-wide project count. Tell the client which it is.
    const revenueIsComplete = await estimateTotalsComplete(projects.map((p: any) => ({ projectId: p.id })));

    return <ProjectsClient
        projects={projects}
        initialStatuses={customStatuses}
        revenueIsComplete={revenueIsComplete}
        canDeleteProjects={canDeleteProjects}
    />;
}
