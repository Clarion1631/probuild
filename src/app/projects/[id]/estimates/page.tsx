import StatusBadge from "@/components/StatusBadge";
import {
  getProject,
  createDraftEstimate,
  duplicateEstimate,
  getEstimateTemplates,
  createEstimateFromTemplate,
} from "@/lib/actions";
import { redirect } from "next/navigation";
import Link from "next/link";
import EstimatesListClient from "./EstimatesListClient";

export default async function EstimatesPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  const project = await getProject(resolvedParams.id);

  if (!project) return <div className="p-6">Project not found</div>;

  const estimates = project.estimates || [];
  let templates: any[] = [];
  try {
    templates = await getEstimateTemplates();
  } catch {}

  // Calculate real stats
  const approvedEstimates = estimates.filter(
    (e: any) => e.status === "Approved" || e.status === "Sent"
  );
  const totalApproved = approvedEstimates.reduce(
    (sum: number, e: any) => sum + (e.totalAmount || 0),
    0
  );
  const totalAll = estimates.reduce((sum: number, e: any) => sum + (e.totalAmount || 0), 0);
  const winRate =
    estimates.length > 0 ? Math.round((approvedEstimates.length / estimates.length) * 100) : 0;

  async function handleNewEstimate() {
    "use server";
    const result = await createDraftEstimate(resolvedParams.id);
    redirect(`/projects/${resolvedParams.id}/estimates/${result.id}`);
  }

  async function handleNewFromTemplate(formData: FormData) {
    "use server";
    const templateId = formData.get("templateId") as string;
    if (!templateId) return;
    const result = await createEstimateFromTemplate(resolvedParams.id, templateId);
    redirect(`/projects/${resolvedParams.id}/estimates/${result.id}`);
  }

  async function handleDuplicate(formData: FormData) {
    "use server";
    const estimateId = formData.get("estimateId") as string;
    if (!estimateId) return;
    const result = await duplicateEstimate(estimateId);
    redirect(`/projects/${resolvedParams.id}/estimates/${result.id}`);
  }

  return (
    <div className="-m-6 flex h-[calc(100vh-64px)] h-full overflow-hidden">
      <div className="flex-1 overflow-auto bg-gradient-to-br from-slate-50 via-white to-slate-50/50">
        <div className="mx-auto max-w-6xl p-8">
          {/* Header */}
          <div className="mb-8 flex items-center justify-between">
            <div>
              <h1 className="text-hui-textMain text-2xl font-bold">Estimates</h1>
              <p className="text-hui-textMuted mt-1 text-sm">
                {estimates.length} estimate{estimates.length !== 1 ? "s" : ""} for {project.name}
              </p>
            </div>
            <EstimatesListClient
              projectId={resolvedParams.id}
              templates={templates}
              handleNewEstimate={handleNewEstimate}
              handleNewFromTemplate={handleNewFromTemplate}
            />
          </div>

          {/* Stats Cards */}
          <div className="mb-8 grid grid-cols-3 gap-5">
            <div className="group relative overflow-hidden rounded-xl border border-slate-200/80 bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
              <div className="absolute top-0 right-0 left-0 h-1 bg-gradient-to-r from-green-400 to-emerald-500" />
              <p className="mb-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">
                Total Approved
              </p>
              <p className="text-2xl font-bold text-slate-900">
                ${totalApproved.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </p>
              <p className="mt-1 text-[10px] text-slate-400">
                {approvedEstimates.length} approved estimate
                {approvedEstimates.length !== 1 ? "s" : ""}
              </p>
            </div>
            <div className="group relative overflow-hidden rounded-xl border border-slate-200/80 bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
              <div className="absolute top-0 right-0 left-0 h-1 bg-gradient-to-r from-blue-400 to-indigo-500" />
              <p className="mb-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">
                Total Value
              </p>
              <p className="text-2xl font-bold text-blue-600">
                ${totalAll.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </p>
              <p className="mt-1 text-[10px] text-slate-400">Across all estimates</p>
            </div>
            <div className="group relative overflow-hidden rounded-xl border border-slate-200/80 bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
              <div className="absolute top-0 right-0 left-0 h-1 bg-gradient-to-r from-purple-400 to-violet-500" />
              <p className="mb-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">
                Win Rate
              </p>
              <div className="flex items-end gap-2">
                <p className="text-2xl font-bold text-purple-600">{winRate}%</p>
                <div className="mb-1.5 h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-purple-400 to-violet-500 transition-all"
                    style={{ width: `${winRate}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Estimates Table */}
          <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-gradient-to-r from-slate-50 to-slate-100/50">
                  <th className="w-28 px-6 py-3.5 text-xs font-semibold tracking-wider text-slate-500 uppercase">
                    #
                  </th>
                  <th className="px-6 py-3.5 text-xs font-semibold tracking-wider text-slate-500 uppercase">
                    Estimate Name
                  </th>
                  <th className="px-6 py-3.5 text-xs font-semibold tracking-wider text-slate-500 uppercase">
                    Status
                  </th>
                  <th className="px-6 py-3.5 text-right text-xs font-semibold tracking-wider text-slate-500 uppercase">
                    Total Amount
                  </th>
                  <th className="px-6 py-3.5 text-right text-xs font-semibold tracking-wider text-slate-500 uppercase">
                    Date
                  </th>
                  <th className="w-24"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {estimates.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-16 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-100 to-purple-100">
                          <svg
                            width="24"
                            height="24"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#6366f1"
                            strokeWidth="1.5"
                          >
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                            <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
                          </svg>
                        </div>
                        <p className="text-sm font-medium text-slate-500">No estimates yet</p>
                        <p className="max-w-xs text-xs text-slate-400">
                          Create your first estimate to start tracking project costs and send
                          proposals to clients.
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
                {estimates.map((est: any) => (
                  <tr key={est.id} className="group transition hover:bg-slate-50/80">
                    <td className="px-6 py-4">
                      <span className="font-mono text-xs font-medium text-slate-400">
                        {est.code}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <Link
                        href={`/projects/${project.id}/estimates/${est.id}`}
                        className="text-hui-textMain hover:text-hui-primary flex items-center gap-2 font-medium transition-colors"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-indigo-100/50 bg-gradient-to-br from-blue-50 to-indigo-50">
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#6366f1"
                            strokeWidth="1.5"
                          >
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                            <path d="M14 2v6h6" />
                          </svg>
                        </div>
                        {est.title}
                      </Link>
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={est.status} />
                    </td>
                    <td className="px-6 py-4 text-right font-semibold text-slate-700">
                      $
                      {(est.totalAmount || 0).toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                      })}
                    </td>
                    <td className="px-6 py-4 text-right text-xs text-slate-400">
                      {new Date(est.createdAt).toLocaleDateString()}
                    </td>
                    <td className="flex items-center justify-end gap-1 px-4 py-4">
                      <form action={handleDuplicate}>
                        <input type="hidden" name="estimateId" value={est.id} />
                        <button
                          type="submit"
                          title="Duplicate estimate"
                          className="rounded p-1.5 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-600"
                        >
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </button>
                      </form>
                      <Link
                        href={`/projects/${project.id}/estimates/${est.id}`}
                        className="text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-slate-600"
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M9 5l7 7-7 7" />
                        </svg>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
