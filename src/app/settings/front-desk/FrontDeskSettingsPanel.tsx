"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
    saveCalendlyTokenAction, clearCalendlyTokenAction, setFrontDeskEventTypesAction, setFrontDeskTakingTransfersAction,
} from "@/lib/front-desk-actions";

interface CallRow {
    id: string;
    conversationId: string;
    isTest: boolean;
    outcome: string | null;
    leadId: string | null;
    createdAt: Date;
}
interface BookingRow {
    id: string;
    conversationId: string;
    startTime: Date;
    updatedAt: Date;
}
interface ActiveTransfer {
    id: string;
    status: string;
    callerName: string;
    preparedAt: Date;
}

interface Props {
    takingTransfers: boolean;
    takingTransfersBy: string | null;
    takingTransfersAt: Date | null;
    calendlyConnected: boolean;
    calendlyTokenSetBy: string | null;
    calendlyTokenSetAt: Date | null;
    calendlyPlan: string | null;
    calendlyAuthFailedAt: Date | null;
    liveEventTypeUri: string;
    testEventTypeUri: string;
    activeTransfer: ActiveTransfer | null;
    recentCalls: CallRow[];
    uncertainBookings: BookingRow[];
}

export default function FrontDeskSettingsPanel(props: Props) {
    const [pending, startTransition] = useTransition();
    const [token, setToken] = useState("");
    const [liveEventTypeUri, setLiveEventTypeUri] = useState(props.liveEventTypeUri);
    const [testEventTypeUri, setTestEventTypeUri] = useState(props.testEventTypeUri);

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
                <h2 className="font-semibold mb-2">Richard — taking transfers</h2>
                <p className="text-xs text-slate-500 mb-3">
                    The no-redeploy transfer off switch and Richard&apos;s holiday control. Off, every transfer offer returns
                    <code className="mx-1">no_transfer:richard_unavailable</code> and the bridge rejects.
                </p>
                {props.takingTransfersBy && (
                    <p className="text-xs text-slate-500 mb-3">Last set by {props.takingTransfersBy} at {props.takingTransfersAt ? new Date(props.takingTransfersAt).toLocaleString() : "—"}</p>
                )}
                <button
                    type="button"
                    className="hui-btn hui-btn-secondary"
                    disabled={pending}
                    onClick={() => run(() => setFrontDeskTakingTransfersAction(!props.takingTransfers), props.takingTransfers ? "Turned off" : "Turned on")}
                >
                    {props.takingTransfers ? "Turn OFF" : "Turn ON"}
                </button>
            </div>

            {props.activeTransfer && (
                <div className="hui-card p-6">
                    <h2 className="font-semibold mb-2">Active transfer</h2>
                    <p className="text-sm">{props.activeTransfer.status} — {props.activeTransfer.callerName} (prepared {new Date(props.activeTransfer.preparedAt).toLocaleString()})</p>
                </div>
            )}

            <div className="hui-card p-6">
                <h2 className="font-semibold mb-2">Richard&apos;s Calendly token</h2>
                {props.calendlyConnected ? (
                    <div className="text-sm space-y-1 mb-3">
                        <p className="text-green-600">Connected.</p>
                        {props.calendlyTokenSetBy && <p>Set by {props.calendlyTokenSetBy} at {props.calendlyTokenSetAt ? new Date(props.calendlyTokenSetAt).toLocaleString() : "—"}</p>}
                        {props.calendlyPlan && <p>Plan / stage: {props.calendlyPlan}</p>}
                        {props.calendlyAuthFailedAt && <p className="text-red-600">Auth failed at {new Date(props.calendlyAuthFailedAt).toLocaleString()} — booking via POST /invitees needs Standard+ (R1).</p>}
                    </div>
                ) : (
                    <p className="text-sm text-slate-500 mb-3">Not connected — booking falls back to &quot;take preferred times&quot;.</p>
                )}
                <div className="flex gap-2 items-center mb-2">
                    <input
                        type="password"
                        autoComplete="off"
                        placeholder="Paste Richard's Calendly personal access token"
                        className="hui-input flex-1"
                        value={token}
                        onChange={e => setToken(e.target.value)}
                    />
                    <button
                        type="button"
                        className="hui-btn hui-btn-primary"
                        disabled={pending || !token.trim()}
                        onClick={() => startTransition(async () => {
                            const result = await saveCalendlyTokenAction(token);
                            if (result.ok) {
                                toast.success("Calendly token verified and saved");
                                setToken("");
                            } else {
                                toast.error(result.error ?? "Save failed");
                            }
                        })}
                    >
                        Verify &amp; save
                    </button>
                </div>
                {props.calendlyConnected && (
                    <button
                        type="button"
                        className="hui-btn hui-btn-secondary"
                        disabled={pending}
                        onClick={() => run(clearCalendlyTokenAction, "Token cleared — booking is now OFF")}
                    >
                        Clear token (turns booking OFF)
                    </button>
                )}
            </div>

            <div className="hui-card p-6">
                <h2 className="font-semibold mb-2">Calendly events</h2>
                <p className="text-xs text-slate-500 mb-3">Event type URIs from Richard&apos;s Calendly account (R2): the live 15-minute event, and a secret test copy.</p>
                <div className="space-y-2">
                    <input className="hui-input w-full" placeholder="Live event type URI" value={liveEventTypeUri} onChange={e => setLiveEventTypeUri(e.target.value)} />
                    <input className="hui-input w-full" placeholder="Test event type URI" value={testEventTypeUri} onChange={e => setTestEventTypeUri(e.target.value)} />
                    <button
                        type="button"
                        className="hui-btn hui-btn-secondary"
                        disabled={pending}
                        onClick={() => run(() => setFrontDeskEventTypesAction(liveEventTypeUri, testEventTypeUri), "Event types saved")}
                    >
                        Save events
                    </button>
                </div>
            </div>

            <div className="hui-card p-6">
                <h2 className="font-semibold mb-2">Recent calls</h2>
                {props.recentCalls.length === 0 ? (
                    <p className="text-sm text-slate-500">None yet.</p>
                ) : (
                    <ul className="text-sm space-y-1">
                        {props.recentCalls.map(c => (
                            <li key={c.id}>
                                {c.isTest && <span className="text-slate-400">[TEST] </span>}
                                {c.outcome ?? "pending"} — {new Date(c.createdAt).toLocaleString()}
                                {c.leadId && <> — <a className="text-blue-600 underline" href={`/leads/${c.leadId}`}>lead</a></>}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="hui-card p-6">
                <h2 className="font-semibold mb-2">Uncertain bookings</h2>
                {props.uncertainBookings.length === 0 ? (
                    <p className="text-sm text-slate-500">None.</p>
                ) : (
                    <ul className="text-sm space-y-1">
                        {props.uncertainBookings.map(b => (
                            <li key={b.id}>{new Date(b.startTime).toLocaleString()} — last checked {new Date(b.updatedAt).toLocaleString()}</li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
