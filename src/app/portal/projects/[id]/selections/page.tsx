import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { getSelectionBoardsForPortal, getPortalVisibility } from "@/lib/actions";
import Link from "next/link";
import PortalSelectionsClient from "./PortalSelectionsClient";

export default async function PortalSelectionsPage(props: { params: Promise<{ id: string }> }) {
    const { id } = await props.params;

    const project = await prisma.project.findFirst({
        where: { id },
        include: { client: true },
    });

    if (!project) return notFound();

    const visibility = await getPortalVisibility(id);
    if (!visibility.isPortalEnabled || !visibility.showSelections) {
        return (
            <div className="max-w-3xl mx-auto py-16 px-4 text-center">
                <div className="bg-white border border-slate-200 rounded-xl p-8 shadow-sm">
                    <h2 className="text-xl font-bold text-slate-800 mb-2">Selections Not Available</h2>
                    <p className="text-slate-500 mb-4">Selection boards are not currently available for this project.</p>
                    <Link href={`/portal/projects/${id}`} className="hui-btn hui-btn-primary">
                        Back to Project
                    </Link>
                </div>
            </div>
        );
    }

    const boards = await getSelectionBoardsForPortal(id);

    return (
        <div className="max-w-5xl mx-auto py-8 px-4">
            <div className="mb-6">
                <Link
                    href={`/portal/projects/${id}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm w-fit"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Project
                </Link>
            </div>

            <div className="mb-8">
                <h1 className="text-3xl font-bold text-hui-textMain mb-2">Selections</h1>
                <p className="text-sm text-hui-textMuted">
                    Browse the options below and select your preferred choice for each category.
                </p>
            </div>

            {boards.length === 0 ? (
                <div className="hui-card p-12 text-center">
                    <h3 className="text-lg font-semibold text-hui-textMain mb-2">No Selection Boards Available</h3>
                    <p className="text-sm text-hui-textMuted">Your project manager hasn&apos;t shared any selection boards yet.</p>
                </div>
            ) : (
                <PortalSelectionsClient boards={JSON.parse(JSON.stringify(boards))} />
            )}
        </div>
    );
}
