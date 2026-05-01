"use client";
import { useState, useTransition } from "react";
import { saveCompanySettings } from "@/lib/actions";
import { toast } from "sonner";

const NOTIFICATION_EVENTS = [
    { key: "newLead", label: "New Lead", description: "When a new lead is created or received via contact form" },
    { key: "estimateViewed", label: "Estimate Viewed", description: "When a client opens an estimate you sent" },
    { key: "estimateSigned", label: "Estimate Signed", description: "When a client approves or signs an estimate" },
    { key: "contractSigned", label: "Contract Signed", description: "When a client signs a contract" },
    { key: "invoiceViewed", label: "Invoice Viewed", description: "When a client opens an invoice" },
    { key: "paymentReceived", label: "Payment Received", description: "When a client makes a payment" },
    { key: "messageReceived", label: "New Message", description: "When a client or subcontractor sends a message" },
];

function parseToggles(raw: string | null): Record<string, boolean> {
    const defaults = Object.fromEntries(NOTIFICATION_EVENTS.map(e => [e.key, true]));
    if (!raw) return defaults;
    try {
        const parsed = JSON.parse(raw);
        return { ...defaults, ...parsed };
    } catch {
        return defaults;
    }
}

export default function NotificationsClient({
    initialEmail,
    initialToggles,
}: {
    initialEmail: string;
    initialToggles: string | null;
}) {
    const [email, setEmail] = useState(initialEmail);
    const [events, setEvents] = useState<Record<string, boolean>>(() => parseToggles(initialToggles));
    const [isPending, startTransition] = useTransition();

    const handleSave = () => {
        startTransition(async () => {
            try {
                await saveCompanySettings({
                    notificationEmail: email,
                    notificationToggles: JSON.stringify(events),
                } as any);
                toast.success("Notification settings saved");
            } catch {
                toast.error("Failed to save settings");
            }
        });
    };

    return (
        <div className="space-y-6">
            <div className="hui-card p-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-1">Notification Email</h2>
                <p className="text-sm text-hui-textMuted mb-4">All system notifications will be sent to this address.</p>
                <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@yourcompany.com"
                    className="hui-input w-full max-w-sm"
                />
            </div>

            <div className="hui-card p-6">
                <h2 className="text-base font-semibold text-hui-textMain mb-1">Notify Me When</h2>
                <p className="text-sm text-hui-textMuted mb-4">Choose which events trigger email notifications.</p>
                <div className="divide-y divide-hui-border">
                    {NOTIFICATION_EVENTS.map((event) => (
                        <label key={event.key} className="flex items-center justify-between py-3 cursor-pointer group">
                            <div>
                                <div className="text-sm font-medium text-hui-textMain">{event.label}</div>
                                <div className="text-xs text-hui-textMuted mt-0.5">{event.description}</div>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={events[event.key]}
                                onClick={() => setEvents(prev => ({ ...prev, [event.key]: !prev[event.key] }))}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-hui-primary focus:ring-offset-2 ${events[event.key] ? "bg-hui-primary" : "bg-slate-300"}`}
                            >
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${events[event.key] ? "translate-x-6" : "translate-x-1"}`} />
                            </button>
                        </label>
                    ))}
                </div>
            </div>

            <button onClick={handleSave} disabled={isPending} className="hui-btn hui-btn-primary">
                {isPending ? "Saving..." : "Save Notifications"}
            </button>
        </div>
    );
}
