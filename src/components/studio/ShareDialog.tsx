"use client";

// Room Studio - client share dialog. Toggle the public link, copy it, rotate it.

import { useState } from "react";
import { X, Copy, RefreshCcw, Check, Globe, Lock } from "lucide-react";
import { toast } from "sonner";

export interface ShareState {
  enabled: boolean;
  token: string | null;
}

export function ShareDialog({
  roomId, share, onChange, onClose,
}: {
  roomId: string;
  share: ShareState;
  onChange: (next: ShareState) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const url = share.token ? `${window.location.origin}/share/room/${share.token}` : null;

  const enable = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/share`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      onChange({ enabled: true, token: data.token });
      toast.success("Client link is live");
    } catch {
      toast.error("Couldn't enable sharing");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/share`, { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      onChange({ ...share, enabled: false });
      toast.success("Sharing turned off");
    } catch {
      toast.error("Couldn't disable sharing");
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/share/regenerate`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      onChange({ enabled: true, token: data.token });
      toast.success("New link created - the old one no longer works");
    } catch {
      toast.error("Couldn't rotate the link");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-800">Share with client</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-slate-500">
          Anyone with the link can view this design in 3D - no login needed. They can&apos;t edit anything.
        </p>

        <div className={`mb-3 flex items-center justify-between rounded-xl border p-3 ${share.enabled ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
          <div className="flex items-center gap-2.5">
            {share.enabled
              ? <Globe className="h-4.5 w-4.5 h-5 w-5 text-emerald-600" />
              : <Lock className="h-5 w-5 text-slate-400" />}
            <div>
              <div className="text-sm font-semibold text-slate-800">
                {share.enabled ? "Link sharing is on" : "Link sharing is off"}
              </div>
              <div className="text-[11px] text-slate-500">
                {share.enabled ? "Visible to anyone with the link" : "Only your team can see this design"}
              </div>
            </div>
          </div>
          <button
            disabled={busy}
            onClick={share.enabled ? disable : enable}
            className={`relative h-6 w-11 rounded-full transition-colors ${share.enabled ? "bg-emerald-500" : "bg-slate-300"} disabled:opacity-50`}
            aria-label="Toggle sharing"
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${share.enabled ? "left-[22px]" : "left-0.5"}`}
            />
          </button>
        </div>

        {share.enabled && url && (
          <>
            <div className="flex items-center gap-1.5">
              <input
                readOnly
                value={url}
                onFocus={(e) => e.target.select()}
                className="flex-1 truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 outline-none"
              />
              <button
                onClick={copy}
                className="flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-bold text-white hover:bg-blue-700"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <button
              disabled={busy}
              onClick={regenerate}
              className="mt-2.5 flex items-center gap-1.5 text-[11px] font-medium text-slate-400 hover:text-slate-600"
            >
              <RefreshCcw className="h-3 w-3" />
              Create a new link (old link stops working)
            </button>
          </>
        )}
      </div>
    </div>
  );
}
