"use client";
import { toast } from "sonner";

const INTEGRATIONS = [
    {
        name: "QuickBooks Online",
        description: "Sync invoices, payments, expenses, and vendor data with QuickBooks.",
        icon: "/quickbooks-logo.png",
        iconFallback: "QB",
        iconColor: "bg-green-100 text-green-700",
        status: "coming_soon",
    },
    {
        name: "Zapier",
        description: "Connect ProBuild to 5,000+ apps. Automate workflows without code.",
        icon: null,
        iconFallback: "ZP",
        iconColor: "bg-orange-100 text-orange-700",
        status: "coming_soon",
    },
    {
        name: "Google Drive",
        description: "Sync project files and documents with your Google Drive.",
        icon: null,
        iconFallback: "GD",
        iconColor: "bg-blue-100 text-blue-700",
        status: "coming_soon",
    },
    {
        name: "Dropbox",
        description: "Automatically back up project files to Dropbox.",
        icon: null,
        iconFallback: "DB",
        iconColor: "bg-indigo-100 text-indigo-700",
        status: "coming_soon",
    },
    {
        name: "Google Calendar",
        description: "Sync project schedules and tasks with Google Calendar.",
        icon: null,
        iconFallback: "GC",
        iconColor: "bg-red-100 text-red-700",
        status: "coming_soon",
    },
    {
        name: "Gmail",
        description: "Send and receive project emails directly inside ProBuild.",
        icon: null,
        iconFallback: "GM",
        iconColor: "bg-rose-100 text-rose-700",
        status: "coming_soon",
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
                                <div className="text-xs text-hui-textMuted bg-slate-100 px-2 py-0.5 rounded inline-block mt-0.5">Coming Soon</div>
                            </div>
                        </div>
                        <p className="text-sm text-hui-textMuted">{integration.description}</p>
                        <button
                            className="hui-btn hui-btn-secondary text-sm mt-auto"
                            onClick={() => toast.info(`${integration.name} integration coming soon`)}
                        >
                            Connect
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
