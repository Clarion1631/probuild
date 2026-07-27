export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getProjects } from "@/lib/actions";
import ClipClient from "./ClipClient";

// The bookmarklet capture popup — team-authed. Rendered bare (AppLayout treats
// /clip as a public route so it skips the sidebar/header), but auth is still
// enforced right here exactly like every other team page: no session -> normal
// login redirect, CLIENT role -> portal.
export default async function ClipPage(props: { searchParams: Promise<{ url?: string }> }) {
    const { url } = await props.searchParams;

    const session = await getSessionOrDev();
    if (!session?.user) redirect("/login");
    const role = (session.user as any)?.role;
    if (role === "CLIENT") redirect("/portal");

    let allProjects: { id: string; name: string }[] = [];
    try {
        const allProjs = await getProjects();
        allProjects = allProjs
            .filter((p: any) => p.status !== "Archived")
            .map((p: any) => ({ id: p.id, name: p.name }));
    } catch {}

    return <ClipClient initialUrl={url || ""} allProjects={allProjects} />;
}
