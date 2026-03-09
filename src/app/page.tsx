import StatusBadge, { StatusType } from "@/components/StatusBadge";
import Avatar from "@/components/Avatar";
import { getProjects } from "@/lib/actions";
import Link from "next/link";

export default async function Dashboard() {
  const projects = await getProjects();

  return (
        <main className="flex-1 p-8 bg-gray-100">
          {/* Main Content Header */}
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 tracking-tight">ProBuild Dashboard</h1>
              <p className="text-gray-500 text-sm mt-1 font-medium uppercase tracking-wider">Manage Your Projects</p>
            </div>
            <div className="flex items-center gap-4">
              <button className="bg-white border border-gray-200 px-4 py-2 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm">
                Import Data
              </button>
              <button className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-semibold shadow-md hover:bg-blue-700 transform hover:-translate-y-0.5 transition-all active:scale-95">
                + New Project
              </button>
            </div>
          </div>

          {/* Featured Project Cards - Keeping existing logic but adjusting styling */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            {projects.slice(0, 4).map((p: any) => (
              <Link href={`/projects/${p.id}/estimates`} key={p.id} className="group bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden flex flex-col hover:shadow-xl hover:border-blue-200 transition-all duration-300">
                <div className="h-2 w-full bg-blue-500 opacity-80 group-hover:opacity-100 transition-opacity"></div>
                <div className="p-5 flex-1 flex flex-col justify-between">
                  <div>
                    <h3 className="font-bold text-gray-900 text-base mb-1 group-hover:text-blue-600 transition-colors">{p.name}</h3>
                    <p className="text-xs font-medium text-gray-500 uppercase">{p.client.name}</p>
                  </div>
                  <div className="mt-6 flex items-center justify-between">
                    <StatusBadge status={p.status as StatusType} />
                    <span className="text-gray-300 group-hover:text-gray-500 transition-colors italic text-xs">View Details</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {/* Filters & Search - Keeping existing logic but adjusting styling */}
          <div className="flex flex-wrap items-center gap-4 mb-6 bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
            <div className="relative">
              <input
                type="text"
                placeholder="Search projects..."
                className="border border-gray-200 rounded-lg pl-10 pr-4 py-2 text-sm w-72 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              />
              <svg className="w-4 h-4 absolute left-3 top-2.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            </div>
            <select className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 font-medium text-gray-700 hover:bg-gray-100 transition-colors outline-none cursor-pointer"><option>All Statuses</option></select>
            <select className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 font-medium text-gray-700 hover:bg-gray-100 transition-colors outline-none cursor-pointer"><option>All Managers</option></select>
          </div>

          {/* Main Projects Table - Keeping existing logic but adjusting styling */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="text-xs text-gray-500 bg-gray-50/50 border-b border-gray-200 uppercase tracking-widest font-bold">
                    <th className="px-6 py-4">Project</th>
                    <th className="px-6 py-4">Client</th>
                    <th className="px-6 py-4">Activity</th>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4">Location</th>
                    <th className="px-6 py-4">Tags</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {projects.map((p: any) => (
                    <tr key={p.id} className="hover:bg-blue-50/30 cursor-pointer transition-colors group">
                      <td className="px-6 py-4">
                        <Link href={`/projects/${p.id}/estimates`} className="flex items-center gap-4">
                          <div className="w-1.5 h-8 rounded-full bg-blue-500 group-hover:bg-blue-600 transition-colors"></div>
                          <span className="font-bold text-gray-900 group-hover:text-blue-700 transition-colors">{p.name}</span>
                        </Link>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <Avatar name={p.client.name} color={"blue"} />
                          <span className="text-gray-700 font-medium">{p.client.name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="text-gray-900 font-medium">{new Date(p.viewedAt).toLocaleDateString()}</span>
                          <span className="text-[10px] text-gray-400 uppercase font-bold">Last Viewed</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <StatusBadge status={p.status as StatusType} />
                      </td>
                      <td className="px-6 py-4 text-gray-600 font-medium">{p.location}</td>
                      <td className="px-6 py-4">
                        <button className="text-blue-600 hover:text-blue-800 font-bold text-xs uppercase tracking-tighter opacity-0 group-hover:opacity-100 transition-opacity">+ Add Tags</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </main>
  );
}