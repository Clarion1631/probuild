export const dynamic = "force-dynamic";
import { getProjects, getCompanySettings } from "@/lib/actions";
import ProjectsClient from "./ProjectsClient";

export default async function ProjectsPage() {
    const projects = await getProjects();
    const settings = await getCompanySettings();
    const customStatuses = settings?.projectStatuses ? JSON.parse(settings.projectStatuses) : null;

    return <ProjectsClient projects={projects} initialStatuses={customStatuses} />;
}
