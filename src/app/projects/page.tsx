export const dynamic = "force-dynamic";
import { getProjects } from "@/lib/actions";
import ProjectsClient from "./ProjectsClient";

export default async function ProjectsPage() {
    const projects = await getProjects();

    return <ProjectsClient projects={projects} />;
}
