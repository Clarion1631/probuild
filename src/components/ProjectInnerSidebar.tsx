import Link from "next/link";

interface ProjectInnerSidebarProps {
    projectId: string;
}

export default function ProjectInnerSidebar({ projectId }: ProjectInnerSidebarProps) {
    return (
        <div className="w-56 bg-slate-50 border-r border-slate-200 flex flex-col min-h-full">
            <div className="p-4 border-b border-slate-200 bg-white">
                <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Project Menu</h2>
            </div>

            <div className="flex-1 overflow-y-auto w-full">
                <div className="p-3">
                    <div className="mb-4">
                        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 px-3">Planning</h3>
                        <ul className="space-y-1">
                            <li>
                                <Link href={`/projects/${projectId}/contracts`} className="block px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 hover:text-slate-900 rounded transition">Contracts</Link>
                            </li>
                            <li>
                                <Link href={`/projects/${projectId}/estimates`} className="block px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 hover:text-slate-900 rounded transition font-medium bg-slate-200">Estimates</Link>
                            </li>
                            <li>
                                <Link href={`/projects/${projectId}/takeoffs`} className="block px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 hover:text-slate-900 rounded transition">Takeoffs</Link>
                            </li>
                            <li>
                                <Link href={`/projects/${projectId}/floor-plans`} className="block px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 hover:text-slate-900 rounded transition">3D Floor Plans</Link>
                            </li>
                        </ul>
                    </div>

                    <div className="mb-4">
                        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 px-3">Management</h3>
                        <ul className="space-y-1">
                            <li>
                                <Link href={`/projects/${projectId}/schedule`} className="block px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 hover:text-slate-900 rounded transition">Schedule</Link>
                            </li>
                            <li>
                                <Link href={`/projects/${projectId}/tasks`} className="block px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 hover:text-slate-900 rounded transition">Tasks & Punchlist</Link>
                            </li>
                            <li>
                                <Link href={`/projects/${projectId}/dailylogs`} className="block px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 hover:text-slate-900 rounded transition">Daily Logs</Link>
                            </li>
                        </ul>
                    </div>

                    <div>
                        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 px-3">Finance</h3>
                        <ul className="space-y-1">
                            <li>
                                <Link href={`/projects/${projectId}/invoices`} className="block px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 hover:text-slate-900 rounded transition">Invoices</Link>
                            </li>
                            <li>
                                <Link href={`/projects/${projectId}/changeorders`} className="block px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 hover:text-slate-900 rounded transition">Change Orders</Link>
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
}
