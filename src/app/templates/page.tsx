import Link from "next/link";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getDocumentTemplates } from "@/lib/actions";

export const dynamic = "force-dynamic";

export default async function TemplatesHubPage() {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const docTemplates = await getDocumentTemplates();

    const cards = [
        {
            title: "Document Templates",
            description: "Terms & conditions, contracts, lien releases, and disclaimers.",
            href: "/company/templates",
            count: docTemplates.length,
            icon: (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
            ),
            color: "bg-blue-50 text-blue-600",
        },
        {
            title: "Schedule Templates",
            description: "Pre-built project schedules you can apply to new projects.",
            href: "/templates/schedules",
            count: null,
            comingSoon: true,
            icon: (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="4" width="18" height="18" rx="2" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16 2v4M8 2v4M3 10h18" />
                </svg>
            ),
            color: "bg-green-50 text-green-600",
        },
        {
            title: "Selection Board Templates",
            description: "Reusable selection boards for common project types.",
            href: "/templates/selections",
            count: null,
            comingSoon: true,
            icon: (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                </svg>
            ),
            color: "bg-purple-50 text-purple-600",
        },
        {
            title: "Mood Board Templates",
            description: "Inspiration boards for kitchen, bath, and outdoor projects.",
            href: "/templates/mood-boards",
            count: null,
            comingSoon: true,
            icon: (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 9h18M9 21V9" />
                </svg>
            ),
            color: "bg-pink-50 text-pink-600",
        },
    ];

    return (
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Templates</h1>
                <p className="text-sm text-hui-textMuted mt-1">Reusable templates for documents, schedules, selections, and mood boards.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {cards.map(card => (
                    <Link
                        key={card.title}
                        href={card.href}
                        className={`hui-card p-6 flex gap-4 hover:shadow-md transition-shadow ${card.comingSoon ? "opacity-70" : ""}`}
                    >
                        <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${card.color}`}>
                            {card.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <h3 className="font-semibold text-hui-textMain">{card.title}</h3>
                                {card.comingSoon && (
                                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 uppercase tracking-wider">Soon</span>
                                )}
                                {card.count !== null && (
                                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-hui-primary/10 text-hui-primary">{card.count}</span>
                                )}
                            </div>
                            <p className="text-sm text-hui-textMuted mt-1">{card.description}</p>
                        </div>
                        <svg className="w-5 h-5 text-hui-textMuted shrink-0 self-center" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                    </Link>
                ))}
            </div>
        </div>
    );
}
