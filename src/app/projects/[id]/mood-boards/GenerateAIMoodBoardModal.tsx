"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function GenerateAIMoodBoardModal({ projectId }: { projectId: string }) {
    const [isOpen, setIsOpen] = useState(false);
    const [prompt, setPrompt] = useState("");
    const [baseImageUrl, setBaseImageUrl] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState("");
    const router = useRouter();

    const handleGenerate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!prompt) return;

        setIsGenerating(true);
        setError("");

        try {
            const res = await fetch("/api/ai/mood-board", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId, prompt, baseImageUrl })
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Failed to generate");
            }

            setIsOpen(false);
            setPrompt("");
            setBaseImageUrl("");
            router.refresh();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setIsGenerating(false);
        }
    };

    return (
        <>
            <button
                onClick={() => setIsOpen(true)}
                className="hui-btn flex items-center gap-2 bg-gradient-to-r from-purple-500 to-indigo-600 text-white hover:from-purple-600 hover:to-indigo-700 shadow-sm border-0"
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                </svg>
                AI Generator Wiz
            </button>

            {isOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-gradient-to-r from-purple-500 to-indigo-600">
                            <h2 className="text-xl font-bold text-white flex items-center gap-2">
                                <svg className="w-5 h-5 text-purple-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                                </svg>
                                AI Mood Board Wizard
                            </h2>
                            <button onClick={() => !isGenerating && setIsOpen(false)} className="text-purple-100 hover:text-white transition">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        
                        <form onSubmit={handleGenerate} className="p-6">
                            {error && (
                                <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm border border-red-200">
                                    {error}
                                </div>
                            )}

                            <div className="space-y-5">
                                <div>
                                    <label className="block text-sm font-semibold text-slate-700 mb-1">
                                        Design Theme / Prompt <span className="text-red-500">*</span>
                                    </label>
                                    <textarea
                                        className="hui-input w-full h-24 resize-none"
                                        placeholder="e.g. Modern farmhouse living room with dark wood accents, lots of natural light, and a cozy cream sofa."
                                        value={prompt}
                                        onChange={e => setPrompt(e.target.value)}
                                        disabled={isGenerating}
                                        required
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-semibold text-slate-700 mb-1">
                                        Base Image URL (Optional)
                                    </label>
                                    <input
                                        type="url"
                                        className="hui-input w-full"
                                        placeholder="https://example.com/client-room-photo.jpg"
                                        value={baseImageUrl}
                                        onChange={e => setBaseImageUrl(e.target.value)}
                                        disabled={isGenerating}
                                    />
                                    <p className="text-xs text-slate-500 mt-1.5">
                                        Provide a photo of the client's space. Gemini Vision will analyze it to suggest complementary styling elements.
                                    </p>
                                </div>
                            </div>

                            <div className="mt-8 flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={() => setIsOpen(false)}
                                    className="hui-btn bg-white border border-slate-200 text-slate-700 hover:bg-slate-50"
                                    disabled={isGenerating}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={!prompt.trim() || isGenerating}
                                    className="hui-btn bg-gradient-to-r from-purple-500 to-indigo-600 text-white hover:from-purple-600 hover:to-indigo-700 disabled:opacity-50"
                                >
                                    {isGenerating ? (
                                        <div className="flex items-center gap-2">
                                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                            <span>Generating Magic...</span>
                                        </div>
                                    ) : (
                                        "Generate Mood Board"
                                    )}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </>
    );
}
