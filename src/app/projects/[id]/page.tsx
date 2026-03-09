export default async function ProjectDashboardPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <div className="max-w-6xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Project Overview</h1>
                    <p className="text-hui-textMuted text-sm mt-1">Project ID: {id}</p>
                </div>
                <div className="flex space-x-3">
                    <button className="hui-btn hui-btn-secondary">Edit Details</button>
                    <button className="hui-btn hui-btn-primary">Share</button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="hui-card p-6 col-span-2">
                    <h2 className="text-lg font-bold text-hui-textMain mb-4">Recent Activity</h2>
                    <div className="space-y-4">
                        <div className="flex items-start">
                            <div className="bg-blue-100 p-2 rounded-full mr-3 mt-1">
                                <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                            </div>
                            <div>
                                <p className="text-sm font-medium text-hui-textMain">Estimate #E-1002 Sent</p>
                                <p className="text-xs text-hui-textMuted">Today at 10:45 AM</p>
                            </div>
                        </div>
                        <div className="flex items-start">
                            <div className="bg-green-100 p-2 rounded-full mr-3 mt-1">
                                <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                            </div>
                            <div>
                                <p className="text-sm font-medium text-hui-textMain">Payment Received - $5,000</p>
                                <p className="text-xs text-hui-textMuted">Yesterday at 3:30 PM</p>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="space-y-6">
                    <div className="hui-card p-6">
                        <h2 className="text-sm font-bold text-hui-textMuted uppercase tracking-wider mb-4">Financials Snapshot</h2>
                        <div className="space-y-3">
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-hui-textMuted">Budget:</span>
                                <span className="font-medium text-hui-textMain">$45,000.00</span>
                            </div>
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-hui-textMuted">Invoiced:</span>
                                <span className="font-medium text-hui-textMain">$12,500.00</span>
                            </div>
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-hui-textMuted">Paid:</span>
                                <span className="font-medium text-green-600">$12,500.00</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
