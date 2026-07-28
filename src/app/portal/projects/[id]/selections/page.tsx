import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import {
    getSelectionBoardsForPortal,
    getPortalVisibility,
    getSelectionProposalsForPortal,
    getProjectFavoritesForPortal,
} from "@/lib/actions";
import Link from "next/link";
import PortalSelectionsClient from "./PortalSelectionsClient";
import PortalProjectFavorites from "./PortalProjectFavorites";
import PortalSuggestionsSection from "./PortalSuggestionsSection";

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

    const [boards, proposals, favorites] = await Promise.all([
        getSelectionBoardsForPortal(id),
        getSelectionProposalsForPortal(id),
        getProjectFavoritesForPortal(id),
    ]);

    // Only show the read-only Favorites section when there's something to look
    // at, or when the tab already has other content (boards/proposals) so an
    // empty Favorites card isn't the only thing on an otherwise-empty page —
    // the "Your suggestions" section below always renders and covers that case
    // with its own invite-to-suggest empty state.
    const showFavorites = favorites.length > 0 || boards.length > 0 || proposals.length > 0;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

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

            <div className="mt-12 space-y-12">
                {showFavorites && (
                    <PortalProjectFavorites favorites={JSON.parse(JSON.stringify(favorites))} />
                )}
                <PortalSuggestionsSection
                    projectId={id}
                    initialProposals={JSON.parse(JSON.stringify(proposals))}
                    appUrl={appUrl}
                />
            </div>
        </div>
    );
}
