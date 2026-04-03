export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

interface Props {
    params: Promise<{ id: string }>;
}

export default async function BidPackagesPage({ params }: Props) {
    const { id } = await params;
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    return (
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold text-hui-textMain">Bid Packages</h1>
                <button className="hui-btn hui-btn-primary text-sm" disabled>+ New Bid Package</button>
            </div>
            <div className="hui-card p-12 text-center">
                <div className="w-12 h-12 bg-hui-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-6 h-6 text-hui-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                </div>
                <p className="font-semibold text-hui-textMain mb-2">Bid Packages Coming Soon</p>
                <p className="text-sm text-hui-textMuted mb-6">Send scopes of work to subcontractors, collect bids, and award contracts — all in one place.</p>
                <Link href={`/projects/${id}/subcontractors`} className="hui-btn hui-btn-secondary text-sm">
                    Manage Subcontractors
                </Link>
            </div>
        </div>
    );
}
