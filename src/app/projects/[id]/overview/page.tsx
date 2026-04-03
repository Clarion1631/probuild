import { redirect } from "next/navigation";

interface Props {
    params: Promise<{ id: string }>;
}

export default async function ProjectOverviewRedirect({ params }: Props) {
    const { id } = await params;
    redirect(`/projects/${id}`);
}
