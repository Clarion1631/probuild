import Link from "next/link";

export default function ScheduleTemplatesPage() {
    return (
        <div className="max-w-3xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center gap-2 text-sm text-hui-textMuted mb-2">
                <Link href="/templates" className="hover:text-hui-textMain">Templates</Link>
                <span>/</span>
                <span>Schedules</span>
            </div>
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Schedule Templates</h1>
                <p className="text-sm text-hui-textMuted mt-1">Reusable project schedules you can apply to new projects.</p>
            </div>
            <div className="hui-card p-12 text-center">
                <div className="w-12 h-12 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <rect x="3" y="4" width="18" height="18" rx="2" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 2v4M8 2v4M3 10h18" />
                    </svg>
                </div>
                <p className="font-semibold text-hui-textMain mb-2">Schedule Templates Coming Soon</p>
                <p className="text-sm text-hui-textMuted mb-6">
                    Build reusable schedules for common project types like kitchen remodels, bathroom renovations, and more. Apply them to projects with a single click.
                </p>
                <Link href="/templates" className="hui-btn hui-btn-secondary text-sm">Back to Templates</Link>
            </div>
        </div>
    );
}
