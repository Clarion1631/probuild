export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getLeadNotes } from "@/lib/lead-note-actions";
import { prisma } from "@/lib/prisma";
import LeadNotesPageClient from "./LeadNotesPageClient";

interface Props {
    params: Promise<{ id: string }>;
}

export default async function LeadNotesPage({ params }: Props) {
    const { id } = await params;

    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const [notes, lead] = await Promise.all([
        getLeadNotes(id),
        prisma.lead.findUnique({ where: { id }, select: { name: true } }),
    ]);

    if (!lead) return redirect("/leads");

    const userName = (session.user as any)?.name ?? "Team Member";

    return <LeadNotesPageClient leadId={id} initialNotes={notes} userName={userName} />;
}
