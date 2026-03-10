export default async function ProjectDashboardPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <div className="max-w-7xl mx-auto flex gap-8">
            {/* Main Content Area */}
            <div className="flex-1 space-y-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-bold text-hui-textMain">Project Overview</h1>
                        <p className="text-hui-textMuted text-sm mt-1">Project ID: {id}</p>
                    </div>
                    <div className="flex space-x-3">
                        <button className="hui-btn hui-btn-secondary">Edit Details</button>
                        <button className="hui-btn hui-btn-primary">Share</button>
                    </div>
                </div>

                <div className="space-y-6">
                    <div className="hui-card p-6 border-t-4 border-t-hui-primary">
                        <h2 className="text-sm font-bold text-hui-textMuted uppercase tracking-wider mb-6">Financials Snapshot</h2>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            <div className="space-y-1">
                                <span className="text-hui-textMuted text-sm font-medium">Budget</span>
                                <p className="text-3xl font-bold text-hui-textMain">$45,000.00</p>
                            </div>
                            <div className="space-y-1">
                                <span className="text-hui-textMuted text-sm font-medium">Invoiced</span>
                                <p className="text-3xl font-bold text-hui-textMain">$12,500.00</p>
                            </div>
                            <div className="space-y-1">
                                <span className="text-hui-textMuted text-sm font-medium">Paid</span>
                                <p className="text-3xl font-bold text-green-600">$12,500.00</p>
                            </div>
                        </div>
                        <div className="mt-8 pt-6 border-t border-hui-border grid grid-cols-2 gap-4">
                            <button className="hui-btn hui-btn-secondary w-full">View Invoices</button>
                            <button className="hui-btn hui-btn-secondary w-full">View Estimates</button>
                        </div>
                    </div>

                    <div className="hui-card p-0">
                        <div className="p-6 border-b border-hui-border bg-slate-50 flex items-center justify-between">
                            <h2 className="text-lg font-bold text-hui-textMain">Upcoming Tasks</h2>
                            <button className="text-sm font-medium text-hui-primary hover:text-hui-primaryHover">View All</button>
                        </div>
                        <div className="divide-y divide-hui-border">
                            <div className="p-4 flex items-center justify-between hover:bg-slate-50 transition p-6">
                                <div className="flex items-center gap-4">
                                    <input type="checkbox" className="w-5 h-5 rounded border-hui-border text-hui-primary focus:ring-hui-primary" />
                                    <div>
                                        <p className="font-medium text-hui-textMain">Order kitchen cabinets</p>
                                        <p className="text-sm text-red-500 font-medium">Overdue by 2 days</p>
                                    </div>
                                </div>
                                <span className="px-2.5 py-1 bg-red-100 text-red-800 text-xs font-medium rounded-full">High Priority</span>
                            </div>
                            <div className="p-4 flex items-center justify-between hover:bg-slate-50 transition p-6">
                                <div className="flex items-center gap-4">
                                    <input type="checkbox" className="w-5 h-5 rounded border-hui-border text-hui-primary focus:ring-hui-primary" />
                                    <div>
                                        <p className="font-medium text-hui-textMain">Schedule plumbing inspection</p>
                                        <p className="text-sm text-hui-textMuted">Tomorrow at 10:00 AM</p>
                                    </div>
                                </div>
                                <span className="px-2.5 py-1 bg-slate-100 text-slate-800 text-xs font-medium rounded-full">Normal</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Right Sidebar - Comms & Activity */}
            <div className="w-80 flex flex-col gap-6">
                <div className="hui-card p-6 flex flex-col bg-white">
                    <h3 className="font-bold text-hui-textMain mb-4 flex items-center gap-2 pb-4 border-b border-slate-100">
                        <svg className="w-5 h-5 text-hui-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                        </svg>
                        Communications & Activity
                    </h3>
                    
                    <div className="space-y-6 relative before:absolute before:inset-0 before:-left-3 before:w-0.5 before:bg-slate-100 before:z-0 ml-3">
                        
                        {/* Feed Item 1 */}
                        <div className="relative pl-6 z-10">
                            <div className="absolute -left-1.5 top-1 w-3.5 h-3.5 rounded-full border-2 border-white bg-blue-500 shadow-sm"></div>
                            <div className="flex flex-col">
                                <p className="text-sm font-semibold text-slate-800">Estimate #E-1002 Sent</p>
                                <p className="text-xs text-slate-500 mt-0.5">Today at 10:45 AM by You</p>
                                <div className="mt-2 text-sm text-slate-600 bg-slate-50 p-3 rounded-md border border-slate-100">
                                    "Hi John, please review the final estimate for the kitchen remodel. Let me know if you have any questions."
                                </div>
                            </div>
                        </div>

                        {/* Feed Item 2 */}
                        <div className="relative pl-6 z-10">
                            <div className="absolute -left-1.5 top-1 w-3.5 h-3.5 rounded-full border-2 border-white bg-green-500 shadow-sm"></div>
                            <div className="flex flex-col">
                                <p className="text-sm font-semibold text-slate-800">Payment Received</p>
                                <p className="text-xs text-slate-500 mt-0.5">Yesterday at 3:30 PM</p>
                                <div className="mt-2 text-sm text-slate-600">
                                    <span className="font-semibold text-green-700 bg-green-50 px-2 py-0.5 rounded border border-green-100">$5,000.00</span> received via Credit Card.
                                </div>
                            </div>
                        </div>

                        {/* Feed Item 3 */}
                        <div className="relative pl-6 z-10">
                            <div className="absolute -left-1.5 top-1 w-3.5 h-3.5 rounded-full border-2 border-white bg-purple-500 shadow-sm"></div>
                            <div className="flex flex-col">
                                <p className="text-sm font-semibold text-slate-800">Internal Note Added</p>
                                <p className="text-xs text-slate-500 mt-0.5">Oct 12 at 9:00 AM by Sarah</p>
                                <div className="mt-2 text-sm text-slate-600 bg-purple-50 p-3 rounded-md border border-purple-100 italic">
                                    Client mentioned they might want to expand the scope to include the guest bathroom if the budget allows.
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="mt-6 pt-4 border-t border-slate-100">
                        <button className="hui-btn w-full text-sm py-2 px-4 border border-slate-200 text-slate-600 bg-slate-50 hover:bg-slate-100 rounded-lg justify-center transition-colors">
                            + Add Note or Log Email
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
