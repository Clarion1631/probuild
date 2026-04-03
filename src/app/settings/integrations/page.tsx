"use client";
import { toast } from "sonner";
import Link from "next/link";

const INTEGRATIONS = [
    {
        name: "QuickBooks Online",
        description: "Sync invoices, estimates, and expenses with QuickBooks. Map cost codes to GL accounts.",
        iconFallback: "QB",
        iconColor: "bg-green-100 text-green-700",
        status: "available",
        href: "/settings/integrations/quickbooks",
    },
    {
        name: "Gusto Payroll",
        description: "Export time entries for payroll. Map team members to Gusto employees.",
        iconFallback: "GT",
        iconColor: "bg-pink-100 text-pink-700",
        status: "available",
        href: "/settings/integrations/gusto",
    },
    {
        name: "Zapier",
        description: "Connect ProBuild to 5,000+ apps. Automate workflows without code.",
        iconFallback: "ZP",
        iconColor: "bg-orange-100 text-orange-700",
        status: "coming_soon",
        href: null,
    },
    {
        name: "Google Drive",
        description: "Sync project files and documents with your Google Drive.",
        iconFallback: "GD",
        iconColor: "bg-blue-100 text-blue-700",
        status: "coming_soon",
        href: null,
    },
    {
        name: "Dropbox",
        description: "Automatically back up project files to Dropbox.",
        iconFallback: "DB",
        iconColor: "bg-indigo-100 text-indigo-700",
        status: "coming_soon",
        href: null,
    },
    {
        name: "Google Calendar",
        description: "Sync project schedules and tasks with Google Calendar.",
        iconFallback: "GC",
        iconColor: "bg-red-100 text-red-700",
        status: "coming_soon",
        href: null,
    },
];

export default function IntegrationsPage() {
    return (
        <div className="max-w-[700px] py-8 px-6">
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-hui-textMain">Integrations</h1>
                <p className="text-sm text-hui-textMuted mt-1">Connect ProBuild with your favorite tools to streamline your workflow.</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {INTEGRATIONS.map((integration) => (
                    <div key={integration.name} className="hui-card p-5 flex flex-col gap-3">
                        <div className="flex items-center gap-3">
                            <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold ${integration.iconColor}`}>
                                {integration.iconFallback}
                            </div>
                            <div>
                                <div className="font-semibold text-hui-textMain text-sm">{integration.name}</div>
                                {integration.status === "available" ? (
                                    <div className="text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded inline-block mt-0.5">Available</div>
                                ) : (
                                    <div className="text-xs text-hui-textMuted bg-slate-100 px-2 py-0.5 rounded inline-block mt-0.5">Coming Soon</div>
                                )}
                            </div>
                        </div>
                        <p className="text-sm text-hui-textMuted">{integration.description}</p>
                        {integration.href ? (
                            <Link href={integration.href} className="hui-btn hui-btn-secondary text-sm mt-auto text-center">
                                Configure
                            </Link>
                        ) : (
                            <button
                                className="hui-btn hui-btn-secondary text-sm mt-auto"
                                onClick={() => toast.info(`${integration.name} integration coming soon`)}
                            >
                                Connect
                            </button>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
