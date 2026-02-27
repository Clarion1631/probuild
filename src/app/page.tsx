import StatusBadge, { StatusType } from "@/components/StatusBadge";
import Avatar from "@/components/Avatar";
import { getProjects, createProject } from "@/lib/actions";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function Dashboard() {
  const projects = await getProjects();

  async function handleCreateProject(formData: FormData) {
    "use server";
    const name = formData.get("name") as string;
    const clientName = formData.get("clientName") as string;
    const location = formData.get("location") as string;
    const type = formData.get("type") as string;
    if (!name || !clientName) return;
    const result = await createProject({ name, clientName, location, type });
    redirect(`/projects/${result.id}/estimates`);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-slate-800">All Projects ({projects.length})</h1>
        <div className="flex items-center gap-3">
          <button className="bg-white border border-slate-300 px-3 py-1.5 rounded text-sm font-medium hover:bg-slate-50 transition">Import with Zapier</button>
          {/* Create Project: uses a details/summary for a no-JS dropdown form */}
          <details className="relative">
            <summary className="bg-slate-900 text-white px-4 py-1.5 rounded text-sm font-medium shadow-sm hover:bg-slate-800 transition cursor-pointer list-none">Create Project</summary>
            <div className="absolute right-0 mt-2 w-80 bg-white rounded-lg shadow-xl border border-slate-200 p-5 z-50">
              <form action={handleCreateProject} className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-slate-600 block mb-1">Project Name *</label>
                  <input name="name" required className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 ring-blue-500 focus:outline-none" placeholder="Kitchen Remodel" />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600 block mb-1">Client Name *</label>
                  <input name="clientName" required className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 ring-blue-500 focus:outline-none" placeholder="John Smith" />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600 block mb-1">Location</label>
                  <input name="location" className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 ring-blue-500 focus:outline-none" placeholder="Portland, OR" />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600 block mb-1">Type</label>
                  <input name="type" className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 ring-blue-500 focus:outline-none" placeholder="Kitchen Remodel" />
                </div>
                <button type="submit" className="w-full bg-slate-900 text-white py-2 rounded text-sm font-medium shadow-sm hover:bg-slate-800 transition">Create</button>
              </form>
            </div>
          </details>
        </div>
      </div>

      {projects.length > 0 && (
        <div className="flex gap-4 mb-6 overflow-x-auto pb-2">
          {projects.slice(0, 4).map((p: any) => (
            <Link href={`/projects/${p.id}/estimates`} key={p.id} className="bg-white min-w-[240px] border border-slate-200 rounded-md shadow-sm overflow-hidden flex flex-col hover:shadow-md transition">
              <div className={`h-1.5 w-full bg-blue-500`}></div>
              <div className="p-4 flex-1 flex flex-col justify-between">
                <div>
                  <h3 className="font-semibold text-slate-800 text-sm mb-1">{p.name}</h3>
                  <p className="text-xs text-slate-500">{p.client?.name}</p>
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <StatusBadge status={p.status as StatusType} />
                  <span className="text-slate-400">•••</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

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
            {projects.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-slate-500">
                  No projects yet. Click "Create Project" to get started.
                </td>
              </tr>
            )}
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
                    <Avatar name={p.client?.name || "?"} color={"pink"} />
                    <span className="text-slate-700">{p.client?.name}</span>
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
