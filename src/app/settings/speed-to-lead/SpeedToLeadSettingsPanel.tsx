"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
    setSpeedToLeadPausedAction,
    saveOutreachTemplateAction,
    approveOutreachTemplateAction,
    revokeOutreachTemplateAction,
    runSpeedToLeadReadinessAction,
    activateSpeedToLeadLiveAction,
} from "@/lib/actions";

interface Template {
    id: string;
    subject: string;
    body: string;
    footer: string;
    fixedPhone: string;
    bookingBaseUrl: string;
    fromAddress: string;
    testOnly: boolean;
    approvedAt: Date | null;
    revokedAt: Date | null;
}

export default function SpeedToLeadSettingsPanel({ paused, templates }: { paused: boolean; templates: Template[] }) {
    const [pending, startTransition] = useTransition();
    const [newTemplate, setNewTemplate] = useState({
        subject: "Got your request, {firstName}",
        body: "Hi {firstName}, thanks for reaching out to Golden Touch Remodeling. Richard got your request, and I'll send you a personal reply shortly. If you'd like to talk sooner, pick a time here: {bookingLink} or call +1 (360) 200-1521. Justin",
        footer: "Golden Touch Remodeling, 5305 NE 121st Ave Suite 310, Vancouver, WA 98682. If you'd rather not hear from me, reply 'no thanks' and I'll stop.",
        fixedPhone: "+1 (360) 200-1521",
        bookingBaseUrl: "https://calendly.com/rlord-goldentouchremodeling/",
        fromAddress: "gtrsupport@goldentouchremodeling.com",
        testOnly: true,
    });

    const run = (fn: () => Promise<unknown>, okMessage: string) => startTransition(async () => {
        try {
            await fn();
            toast.success(okMessage);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Action failed");
        }
    });

    return (
        <div className="space-y-6">
            <div className="hui-card p-6">
                <h2 className="font-semibold mb-2">Kill switch</h2>
                <button
                    type="button"
                    className="hui-btn hui-btn-secondary"
                    disabled={pending}
                    onClick={() => run(() => setSpeedToLeadPausedAction(!paused), paused ? "Unpaused" : "Paused")}
                >
                    {paused ? "Unpause" : "Pause"}
                </button>
            </div>

            <div className="hui-card p-6">
                <h2 className="font-semibold mb-2">Release readiness</h2>
                <div className="flex gap-2">
                    <button type="button" className="hui-btn hui-btn-secondary" disabled={pending} onClick={() => run(() => runSpeedToLeadReadinessAction(), "Readiness check finished")}>
                        Run readiness check
                    </button>
                    <button type="button" className="hui-btn hui-btn-primary" disabled={pending} onClick={() => run(() => activateSpeedToLeadLiveAction(), "LIVE activated")}>
                        Activate LIVE
                    </button>
                </div>
            </div>

            <div className="hui-card p-6">
                <h2 className="font-semibold mb-2">Templates (Template A)</h2>
                {templates.map(t => (
                    <div key={t.id} className="border rounded p-3 mb-2 text-sm">
                        <div>{t.testOnly ? "TEST fixture" : "REAL"} — {t.approvedAt ? "approved" : "not approved"}{t.revokedAt ? " (revoked)" : ""}</div>
                        <div className="whitespace-pre-wrap text-xs text-gray-500">{t.subject}</div>
                        <div className="flex gap-2 mt-2">
                            {!t.approvedAt && !t.revokedAt && (
                                <button type="button" className="hui-btn hui-btn-green" disabled={pending} onClick={() => run(() => approveOutreachTemplateAction(t.id), "Template approved")}>
                                    Approve
                                </button>
                            )}
                            {t.approvedAt && !t.revokedAt && (
                                <button type="button" className="hui-btn hui-btn-secondary" disabled={pending} onClick={() => run(() => revokeOutreachTemplateAction(t.id), "Template revoked")}>
                                    Revoke
                                </button>
                            )}
                        </div>
                    </div>
                ))}

                <details className="mt-4">
                    <summary className="cursor-pointer text-sm font-medium">New template</summary>
                    <div className="space-y-2 mt-2">
                        <textarea className="hui-input w-full" rows={4} value={newTemplate.body} onChange={e => setNewTemplate(v => ({ ...v, body: e.target.value }))} />
                        <label className="text-xs flex items-center gap-1">
                            <input type="checkbox" checked={newTemplate.testOnly} onChange={e => setNewTemplate(v => ({ ...v, testOnly: e.target.checked }))} />
                            Test fixture only
                        </label>
                        <button type="button" className="hui-btn hui-btn-primary" disabled={pending} onClick={() => run(() => saveOutreachTemplateAction(newTemplate), "Template saved")}>
                            Save template
                        </button>
                    </div>
                </details>
            </div>
        </div>
    );
}
