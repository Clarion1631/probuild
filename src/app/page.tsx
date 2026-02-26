import StatusBadge, { StatusType } from "@/components/StatusBadge";
import Avatar from "@/components/Avatar";
import { getProjects } from "@/lib/actions";
import Link from "next/link";

export default async function Dashboard() {
  const projects = await getProjects();

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-slate-800">All Projects (46)</h1>
        <div className="flex items-center gap-3">
          <button className="bg-white border border-slate-300 px-3 py-1.5 rounded text-sm font-medium hover:bg-slate-50 transition">Import with Zapier</button>
          <button className="bg-slate-900 text-white px-4 py-1.5 rounded text-sm font-medium shadow-sm hover:bg-slate-800 transition">Create Project</button>
        </div>
      </div>

      <div className="flex gap-4 mb-6 overflow-x-auto pb-2">
        {/* Project Cards */}
        {projects.slice(0, 4).map((p: any) => (
          <Link href={`/projects/${p.id}/estimates`} key={p.id} className="bg-white min-w-[240px] border border-slate-200 rounded-md shadow-sm overflow-hidden flex flex-col hover:shadow-md transition">
            <div className={`h-1.5 w-full bg-blue-500`}></div>
            <div className="p-4 flex-1 flex flex-col justify-between">
              <div>
                <h3 className="font-semibold text-slate-800 text-sm mb-1">{p.name}</h3>
                <p className="text-xs text-slate-500">{p.client.name}</p>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <StatusBadge status={p.status as StatusType} />
                <span className="text-slate-400">•••</span>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="flex items-center gap-4 mb-4">
        <input type="text" placeholder="Search" className="border border-slate-300 rounded px-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-1 focus:ring-slate-400" />
        <select className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white"><option>Status: All</option></select>
        <select className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white"><option>Tags: None</option></select>
        <select className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white"><option>All Managers</option></select>
      </div>

      <div className="bg-white border border-slate-200 rounded-md shadow-sm flex-1 overflow-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-slate-500 bg-slate-50 border-b border-slate-200 uppercase">
            <tr>
              <th className="px-4 py-3 font-medium">Project Name</th>
              <th className="px-4 py-3 font-medium">Client Name</th>
              <th className="px-4 py-3 font-medium">Viewed</th>
              <th className="px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3 font-medium">Location</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Tags</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {projects.map((p: any) => (
              <tr key={p.id} className="hover:bg-slate-50 cursor-pointer transition">
                <td className="px-4 py-3 font-medium text-slate-800">
                  <Link href={`/projects/${p.id}/estimates`} className="flex items-center gap-3 hover:text-blue-600 transition">
                    <div className={`w-1 h-6 rounded-full bg-blue-400`}></div>
                    {p.name}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Avatar name={p.client.name} color={"pink"} />
                    <span className="text-slate-700">{p.client.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-600">{new Date(p.viewedAt).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-slate-600">{new Date(p.createdAt).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-slate-600">{p.location}</td>
                <td className="px-4 py-3"><StatusBadge status={p.status as StatusType} /></td>
                <td className="px-4 py-3 text-slate-600">{p.type}</td>
                <td className="px-4 py-3 text-blue-600 hover:underline font-medium text-xs">+ Add Tags</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
