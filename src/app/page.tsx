export const dynamic = "force-dynamic";
import StatusBadge, { StatusType } from "@/components/StatusBadge";
import Avatar from "@/components/Avatar";
import { getProjects } from "@/lib/actions";
import Link from "next/link";

export default async function Dashboard() {
  const projects = await getProjects();

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-hui-textMain tracking-tight">Hi, Justin Account</h1>
        <div className="flex gap-3">
          <button className="hui-btn hui-btn-secondary">Customize Dashboard</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Actionable Lists */}
        <div className="lg:col-span-2 space-y-6">
          {/* Projects Widget */}
          <div className="hui-card">
            <div className="p-4 border-b border-hui-border flex justify-between items-center">
              <h2 className="font-semibold text-lg text-hui-textMain">Projects</h2>
              <Link href="/projects" className="text-sm font-medium text-blue-600 hover:underline">View All</Link>
            </div>
            <div className="p-0">
              <table className="w-full text-sm text-left">
                <tbody className="divide-y divide-gray-100">
                  {projects.slice(0, 5).map((p: any) => (
                    <tr key={p.id} className="hover:bg-slate-50 transition-colors group">
                      <td className="px-4 py-3">
                        <Link href={`/projects/${p.id}/estimates`} className="font-semibold text-hui-textMain hover:text-hui-primary transition-colors block">
                          {p.name}
                        </Link>
                        <span className="text-xs text-hui-textMuted">{p.client.name}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <StatusBadge status={p.status as StatusType} />
                      </td>
                    </tr>
                  ))}
                  {projects.length === 0 && (
                    <tr>
                      <td colSpan={2} className="px-4 py-8 text-center text-hui-textMuted text-sm">
                        No active projects.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* To-Do Widget */}
          <div className="hui-card">
            <div className="p-4 border-b border-hui-border flex justify-between items-center">
              <h2 className="font-semibold text-lg text-hui-textMain">To-Do Next 7 Days</h2>
              <span className="text-xs font-semibold bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">0</span>
            </div>
            <div className="p-8 text-center flex flex-col items-center justify-center text-hui-textMuted">
              <svg className="w-10 h-10 mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" /></svg>
              <p className="text-sm font-medium">You don't have any items over the next 7 days.</p>
              <button className="mt-4 text-hui-primary font-medium text-sm hover:underline">Add a To-Do</button>
            </div>
          </div>
        </div>

        {/* Right Column - Quick Actions & Secondary Widgets */}
        <div className="space-y-6">
          {/* Create New Widget */}
          <div className="hui-card">
            <div className="p-4 border-b border-hui-border">
              <h2 className="font-semibold text-lg text-hui-textMain">Create New</h2>
            </div>
            <div className="grid grid-cols-2 gap-px bg-slate-100 p-px">
              <button className="bg-white p-4 flex flex-col items-center justify-center hover:bg-slate-50 transition-colors gap-2 group">
                <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                </div>
                <span className="text-xs font-medium text-hui-textMain">Project</span>
              </button>
              <button className="bg-white p-4 flex flex-col items-center justify-center hover:bg-slate-50 transition-colors gap-2 group">
                <div className="w-10 h-10 rounded-full bg-green-50 text-green-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" /></svg>
                </div>
                <span className="text-xs font-medium text-hui-textMain">Lead</span>
              </button>
              <button className="bg-white p-4 flex flex-col items-center justify-center hover:bg-slate-50 transition-colors gap-2 group">
                <div className="w-10 h-10 rounded-full bg-purple-50 text-purple-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                </div>
                <span className="text-xs font-medium text-hui-textMain">Estimate</span>
              </button>
              <button className="bg-white p-4 flex flex-col items-center justify-center hover:bg-slate-50 transition-colors gap-2 group">
                <div className="w-10 h-10 rounded-full bg-yellow-50 text-yellow-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
                <span className="text-xs font-medium text-hui-textMain">Time Entry</span>
              </button>
            </div>
          </div>

          {/* Quick Links Widget */}
          <div className="hui-card">
             <div className="p-4 border-b border-hui-border">
              <h2 className="font-semibold text-lg text-hui-textMain">Quick Links</h2>
            </div>
            <div className="p-0">
               <ul className="divide-y divide-gray-100">
                  <li><Link href="/time-clock" className="flex items-center justify-between p-4 hover:bg-slate-50 transition-colors"><span className="text-sm font-medium text-hui-textMain">Time & Expenses</span><svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg></Link></li>
                  <li><Link href="/settings/company" className="flex items-center justify-between p-4 hover:bg-slate-50 transition-colors"><span className="text-sm font-medium text-hui-textMain">Company Settings</span><svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg></Link></li>
               </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
