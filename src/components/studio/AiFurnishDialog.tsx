"use client";

import { useState } from "react";
import { Sparkles, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useStudio } from "./store";
import { fromRoomRecord } from "@/lib/studio/doc";

interface AiFurnishDialogProps {
  roomId: string;
  onClose: () => void;
}

export function AiFurnishDialog({ roomId, onClose }: AiFurnishDialogProps) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const loadDoc = useStudio((s) => s.loadDoc);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = prompt.trim();
    if (!query) return;

    setLoading(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/ai-furnish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: query }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to furnish room");

      // Load new doc from returned room record
      const newDoc = fromRoomRecord(data.room);
      loadDoc(newDoc);

      toast.success("Room design generated successfully!");
      onClose();
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to furnish room");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-[540px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-600" />
            <div className="text-sm font-bold text-slate-800">AI Room Furnishing</div>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
          <div className="text-xs text-slate-500 leading-relaxed">
            Type an AI prompt describing how you want this room furnished. Claude will place cabinetry,
            appliances, fixtures, and furniture styled to your instructions. Structural features like doors
            and windows will not be moved.
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Design Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g., A modern kitchen layout with blue island cabinets, white perimeter cabinets, white quartz countertops, stainless steel french-door fridge, and professional gas range."
              disabled={loading}
              className="h-32 w-full resize-none rounded-xl border border-slate-200 p-3 text-xs outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 disabled:bg-slate-50 disabled:text-slate-400"
              required
            />
          </div>

          {/* Action button */}
          <div className="mt-2 flex justify-end gap-2 border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="rounded-lg px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !prompt.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-5 py-2 text-xs font-bold text-white shadow-md hover:bg-blue-700 hover:shadow-lg transition disabled:opacity-50 disabled:hover:shadow-md"
            >
              {loading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Generating Layout...
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  Generate Design
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
