import StatusBadge, { StatusType } from "@/components/StatusBadge";
import Avatar from "@/components/Avatar";
import { getProjects } from "@/lib/actions";
import Link from "next/link";

export default async function Dashboard() {
  const projects = await getProjects();

  return (
    <div className="flex flex-col min-h-screen bg-gray-100">
      {/* Top Header */}
      <header className="bg-white shadow-sm py-4 px-6 flex items-center justify-between border-b border-gray-200">
        <div className="flex items-center">
          {/* Placeholder for 'G' icon if needed */}
          <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white font-bold mr-3">G</div>
          <h1 className="text-xl font-bold text-gray-800">Golden Touch</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-gray-700 text-sm">Justin Adkins</span>
          <Avatar name="Justin" color="gray" />
          <button className="text-blue-600 hover:text-blue-800 text-sm font-semibold">Sign out</button>
        </div>
      </header>

      <div className="flex flex-1">
        {/* Sidebar */}
        <aside className="w-64 bg-white shadow-md p-6 flex flex-col justify-between border-r border-gray-200">
          <div>
            <h2 className="text-2xl font-bold text-gray-800 mb-6">ProBuild</h2>
            <nav>
              <ul className="space-y-2">
                <li>
                  <a href="#" className="flex items-center p-2 text-gray-700 hover:bg-gray-100 rounded-md">
                    <svg className="w-5 h-5 mr-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
                    Dashboard
                  </a>
                </li>
                <li>
                  <a href="#" className="flex items-center p-2 text-gray-700 hover:bg-gray-100 rounded-md">
                    <svg className="w-5 h-5 mr-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10h2m-2 0h2m0 0h2m0 0h2m0 0h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2m-2 10V7" /></svg>
                    Projects
                  </a>
                </li>
                <li>
                  <a href="#" className="flex items-center p-2 text-gray-700 hover:bg-gray-100 rounded-md">
                    <svg className="w-5 h-5 mr-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354l-7.757 7.757a1 1 0 00-1.414 1.414L3 15.414V19a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 002 2h2a2 2 0 002-2v-3.586l.172-.172a1 1 0 00-1.414-1.414L12 4.354z" /></svg>
                    Clients
                  </a>
                </li>
                <li>
                  <a href="#" className="flex items-center p-2 text-gray-700 hover:bg-gray-100 rounded-md">
                    <svg className="w-5 h-5 mr-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /></svg>
                    Settings
                  </a>
                </li>
              </ul>
            </nav>
            {/* Additional Sidebar Items from screenshot */}
            <nav className="mt-8">
              <ul className="space-y-2">
                <li>
                  <a href="#" className="flex items-center p-2 text-gray-700 hover:bg-gray-100 rounded-md">
                    <svg className="w-5 h-5 mr-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    Search
                  </a>
                </li>
                <li>
                  <a href="#" className="flex items-center p-2 text-gray-700 hover:bg-gray-100 rounded-md">
                    <svg className="w-5 h-5 mr-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h8m-10 4h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                    Leads
                  </a>
                </li>
                <li>
                  <a href="#" className="flex items-center p-2 text-gray-700 hover:bg-gray-100 rounded-md">
                    <svg className="w-5 h-5 mr-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2V7a2 2 0 00-2-2H9a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                    Financials
                  </a>
                </li>
                <li>
                  <a href="#" className="flex items-center p-2 text-gray-700 hover:bg-gray-100 rounded-md">
                    <svg className="w-5 h-5 mr-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    Time Clock
                  </a>
                </li>
                <li>
                  <a href="#" className="flex items-center p-2 text-gray-700 hover:bg-gray-100 rounded-md">
                    <svg className="w-5 h-5 mr-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m0 0l-7 7m7-7v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
                    Company
                  </a>
                </li>
              </ul>
            </nav>
          </div>
          {/* User Profile / Logout - keeping existing for now */}
          <div className="border-t border-gray-200 pt-4">
            <button className="flex items-center p-2 text-gray-700 hover:bg-gray-100 rounded-md w-full">
              <Avatar name="Justin" color="green" />
              <span className="ml-3 font-medium">Justin</span>
              <svg className="w-4 h-4 ml-auto text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
            </button>
          </div>
        </aside>

        {/* Main Content Area */}
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
      </div>
    </div>
  );
}
