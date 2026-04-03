export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getLeadScheduleTasks } from "@/lib/actions";
import { prisma } from "@/lib/prisma";
import LeadScheduleClient from "./LeadScheduleClient";

interface Props {
    params: Promise<{ id: string }>;
}

export default async function LeadSchedulePage({ params }: Props) {
    const { id } = await params;

    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const [tasks, lead] = await Promise.all([
        getLeadScheduleTasks(id),
        prisma.lead.findUnique({ where: { id }, select: { name: true } }),
    ]);

    if (!lead) return redirect("/leads");

    return <LeadScheduleClient leadId={id} leadName={lead.name} initialTasks={tasks} />;
}
