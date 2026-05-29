"use client";

import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { createDailyLog, addVoiceEstimateItem } from "@/lib/actions";

type ParsedAction = {
    action: "log_time" | "add_expense" | "daily_log" | "add_estimate_item" | "unknown";
    transcription: string;
    feedbackText: string;
    timeLog?: { hours: number; task: string; projectName: string };
    expense?: { amount: number; vendor: string; item: string; projectName: string };
    dailyLog?: { notes: string; projectName: string };
    estimateItem?: { quantity: number; material: string; unitPrice: number; projectName: string };
};

type Project = {
    id: string;
    name: string;
};

export default function VoiceCommandMic() {
    const { data: session } = useSession();
    const [isRecording, setIsRecording] = useState(false);
    const [status, setStatus] = useState<"idle" | "listening" | "processing" | "confirming" | "success" | "error">("idle");
    const [parsedData, setParsedData] = useState<ParsedAction | null>(null);
    const [projects, setProjects] = useState<Project[]>([]);
    const [matchedProject, setMatchedProject] = useState<Project | null>(null);
    const [countdown, setCountdown] = useState<number | null>(null);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const countdownTimerRef = useRef<NodeJS.Timeout | null>(null);

    // Fetch projects to map voice-inferred names to IDs
    useEffect(() => {
        if (!session?.user) return;
        fetch("/api/projects")
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setProjects(data);
                }
            })
            .catch(err => console.error("Failed to load projects for voice matching:", err));
    }, [session]);

    // Cleanup timers
    useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
        };
    }, []);

    if (!session?.user) return null;

    async function startRecording() {
        try {
            audioChunksRef.current = [];
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // Check browser supported mime type
            let mimeType = "audio/webm";
            if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) {
                mimeType = "audio/ogg;codecs=opus";
            } else if (MediaRecorder.isTypeSupported("audio/wav")) {
                mimeType = "audio/wav";
            }

            const mediaRecorder = new MediaRecorder(stream, { mimeType });
            mediaRecorderRef.current = mediaRecorder;

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
                // Stop all tracks to release mic hardware
                stream.getTracks().forEach(track => track.stop());
                await handleAudioUpload(audioBlob, mimeType);
            };

            mediaRecorder.start();
            setIsRecording(true);
            setStatus("listening");
            setParsedData(null);
            setMatchedProject(null);
            setCountdown(null);
            
            // Auto stop recording after 15 seconds to prevent runaway capturing
            timerRef.current = setTimeout(() => {
                if (mediaRecorderRef.current?.state === "recording") {
                    stopRecording();
                }
            }, 15000);

            toast.info("Listening... Speak your command.", { id: "voice-status" });
        } catch (err) {
            console.error("Failed to start audio recording:", err);
            toast.error("Microphone access is required to use Voice commands.", { id: "voice-status" });
            setStatus("idle");
        }
    }

    function stopRecording() {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
            setStatus("processing");
            toast.loading("Gemini is processing your voice command...", { id: "voice-status" });
        }
    }

    // Resolves project from string name returned by Gemini
    function resolveProject(inferredName: string): Project | null {
        if (!inferredName || projects.length === 0) return null;
        const normalized = inferredName.toLowerCase();
        
        // 1. Direct match
        let match = projects.find(p => p.name.toLowerCase() === normalized);
        if (match) return match;

        // 2. Partial match
        match = projects.find(p => p.name.toLowerCase().includes(normalized) || normalized.includes(p.name.toLowerCase()));
        return match || null;
    }

    async function handleAudioUpload(blob: Blob, mimeType: string) {
        try {
            const formData = new FormData();
            formData.append("audio", blob, `voice-command.${mimeType.split(";")[0].split("/")[1]}`);
            
            // If currently on a project page, extract projectId from URL
            if (typeof window !== "undefined") {
                const projectUrlMatch = window.location.pathname.match(/\/projects\/([^\/]+)/);
                if (projectUrlMatch && projectUrlMatch[1]) {
                    formData.append("projectId", projectUrlMatch[1]);
                }
            }

            const res = await fetch("/api/ai/voice-command", {
                method: "POST",
                body: formData,
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || "Failed to process audio");
            }

            const data: ParsedAction = await res.json();
            
            if (data.action === "unknown") {
                setStatus("idle");
                toast.error("Sorry, I couldn't map that voice command. Try saying: 'Log 4 hours on drywall' or 'Spent 45 dollars at Ace.'", { id: "voice-status", duration: 5000 });
                speakText("Sorry, I didn't catch that command. Please try again.");
                return;
            }

            setParsedData(data);
            setStatus("confirming");
            
            // Map the parsed project name to a database record
            let inferredProjName = "";
            if (data.action === "log_time" && data.timeLog) inferredProjName = data.timeLog.projectName;
            else if (data.action === "add_expense" && data.expense) inferredProjName = data.expense.projectName;
            else if (data.action === "daily_log" && data.dailyLog) inferredProjName = data.dailyLog.projectName;
            else if (data.action === "add_estimate_item" && data.estimateItem) inferredProjName = data.estimateItem.projectName;

            const proj = resolveProject(inferredProjName);
            setMatchedProject(proj);

            toast.success("Voice command recognized!", { id: "voice-status" });
            speakText(data.feedbackText);

            // Start auto-confirm countdown
            setCountdown(4);
        } catch (err: any) {
            console.error("Failed to parse voice command:", err);
            toast.error(err.message || "Failed to process voice command.", { id: "voice-status" });
            setStatus("error");
            setTimeout(() => setStatus("idle"), 3000);
        }
    }

    // Audio text to speech response
    function speakText(text: string) {
        if (typeof window !== "undefined" && "speechSynthesis" in window) {
            window.speechSynthesis.cancel(); // Stop any currently speaking speech
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = 1.05;
            utterance.pitch = 1.0;
            window.speechSynthesis.speak(utterance);
        }
    }

    // Apply the action to the database
    async function applyAction() {
        if (!parsedData) return;
        setStatus("processing");
        toast.loading("Applying transaction...", { id: "voice-status" });

        try {
            const project = matchedProject || projects[0]; // Fallback to first project if none resolved
            if (!project) {
                throw new Error("No active projects found to log this entry to.");
            }

            if (parsedData.action === "log_time" && parsedData.timeLog) {
                const hours = parsedData.timeLog.hours;
                
                // 1. Clock in
                const clockInRes = await fetch("/api/time-entries", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        projectId: project.id,
                        startTime: new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
                    })
                });
                
                if (!clockInRes.ok) throw new Error("Clock-in step failed");
                const timeEntry = await clockInRes.json();

                // 2. Immediately Clock out to calculate costs natively
                const clockOutRes = await fetch("/api/time-entries", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id: timeEntry.id,
                        endTime: new Date().toISOString()
                    })
                });

                if (!clockOutRes.ok) throw new Error("Clock-out step failed");

            } else if (parsedData.action === "add_expense" && parsedData.expense) {
                const res = await fetch("/api/expenses", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        projectId: project.id,
                        amount: parsedData.expense.amount,
                        vendor: parsedData.expense.vendor,
                        description: parsedData.expense.item,
                        date: new Date().toISOString()
                    })
                });

                if (!res.ok) {
                    const errData = await res.json();
                    throw new Error(errData.error || "Expense logging failed");
                }

            } else if (parsedData.action === "daily_log" && parsedData.dailyLog) {
                await createDailyLog(project.id, {
                    date: new Date().toISOString(),
                    workPerformed: parsedData.dailyLog.notes,
                    createdById: (session?.user as any)?.id || "system"
                });

            } else if (parsedData.action === "add_estimate_item" && parsedData.estimateItem) {
                await addVoiceEstimateItem(
                    project.id,
                    parsedData.estimateItem.material,
                    parsedData.estimateItem.quantity,
                    parsedData.estimateItem.unitPrice
                );
            }

            setStatus("success");
            toast.success("Action applied successfully!", { id: "voice-status" });
            
            // Reload page or revalidate to update lists
            if (typeof window !== "undefined") {
                window.location.reload();
            }

            setTimeout(() => setStatus("idle"), 2000);
        } catch (err: any) {
            console.error("Failed to apply voice action:", err);
            toast.error(err.message || "Failed to save action.", { id: "voice-status" });
            setStatus("error");
            setTimeout(() => setStatus("idle"), 3000);
        }
    }

    // Handle countdown timer
    useEffect(() => {
        if (countdown === null) return;
        if (countdown <= 0) {
            setCountdown(null);
            applyAction();
            return;
        }

        countdownTimerRef.current = setTimeout(() => {
            setCountdown(prev => (prev !== null ? prev - 1 : null));
        }, 1000);

        return () => {
            if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
        };
    }, [countdown]);

    function cancelAction() {
        if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
        setCountdown(null);
        setParsedData(null);
        setStatus("idle");
        toast.dismiss("voice-status");
        speakText("Cancelled.");
    }

    return (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3 pointer-events-none">
            {/* Expanded Confirmation/Detail Card */}
            {status !== "idle" && (
                <div className="w-80 bg-white/95 border border-slate-200 backdrop-blur rounded-2xl p-5 shadow-2xl pointer-events-auto transition-all animate-in fade-in slide-in-from-bottom-5">
                    {status === "listening" && (
                        <div className="flex flex-col items-center gap-4 text-center py-2">
                            <div className="relative w-16 h-16 flex items-center justify-center bg-rose-50 rounded-full border border-rose-100">
                                <span className="absolute inset-0 rounded-full bg-rose-500/25 animate-ping" />
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" strokeWidth="2.5"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v1a7 7 0 01-14 0v-1M12 19v4M8 23h8"/></svg>
                            </div>
                            <div>
                                <h4 className="font-bold text-hui-textMain">Listening...</h4>
                                <p className="text-xs text-hui-textMuted mt-1">Speak details of your work logs or expenses</p>
                            </div>
                            <button
                                onClick={() => {
                                    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                                        mediaRecorderRef.current.stop();
                                        setIsRecording(false);
                                        setStatus("idle");
                                        toast.dismiss("voice-status");
                                    }
                                }}
                                className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 transition"
                            >
                                Stop / Cancel
                            </button>
                        </div>
                    )}

                    {status === "processing" && (
                        <div className="flex flex-col items-center gap-4 text-center py-4">
                            <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
                            <div>
                                <h4 className="font-bold text-hui-textMain">Processing Audio...</h4>
                                <p className="text-xs text-hui-textMuted mt-1">Gemini Spark is parsing your command</p>
                            </div>
                        </div>
                    )}

                    {status === "confirming" && parsedData && (
                        <div className="flex flex-col gap-3.5">
                            <div className="flex items-center gap-2">
                                <span className="text-lg">
                                    {parsedData.action === "log_time" ? "🕒" : parsedData.action === "add_expense" ? "💵" : parsedData.action === "daily_log" ? "📝" : "📊"}
                                </span>
                                <h4 className="font-bold text-hui-textMain capitalize">
                                    Confirm {parsedData.action.replace("_", " ")}
                                </h4>
                            </div>

                            <div className="bg-slate-50 border border-slate-100 rounded-xl p-3">
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Spoken Voice Transcript</p>
                                <p className="text-xs text-slate-700 mt-1 italic">"{parsedData.transcription}"</p>
                            </div>

                            {/* Parsed Fields */}
                            <div className="space-y-2 border-t border-slate-100 pt-3">
                                <div className="flex justify-between text-xs">
                                    <span className="text-hui-textMuted">Project:</span>
                                    <span className="font-bold text-hui-textMain truncate max-w-[160px]">
                                        {matchedProject ? matchedProject.name : (parsedData.timeLog?.projectName || parsedData.expense?.projectName || parsedData.dailyLog?.projectName || parsedData.estimateItem?.projectName || "Default Project")}
                                    </span>
                                </div>

                                {parsedData.action === "log_time" && parsedData.timeLog && (
                                    <>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-hui-textMuted">Hours:</span>
                                            <span className="font-bold text-hui-textMain">{parsedData.timeLog.hours} hrs</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-hui-textMuted">Task:</span>
                                            <span className="font-bold text-hui-textMain">{parsedData.timeLog.task || "Framing"}</span>
                                        </div>
                                    </>
                                )}

                                {parsedData.action === "add_expense" && parsedData.expense && (
                                    <>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-hui-textMuted">Amount:</span>
                                            <span className="font-bold text-green-600">${parsedData.expense.amount}</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-hui-textMuted">Vendor:</span>
                                            <span className="font-bold text-hui-textMain">{parsedData.expense.vendor || "Ace"}</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-hui-textMuted">Item:</span>
                                            <span className="font-bold text-hui-textMain truncate max-w-[140px]">{parsedData.expense.item || "Materials"}</span>
                                        </div>
                                    </>
                                )}

                                {parsedData.action === "daily_log" && parsedData.dailyLog && (
                                    <div className="text-xs">
                                        <span className="text-hui-textMuted block mb-1">Notes:</span>
                                        <span className="font-medium text-hui-textMain block bg-slate-50 border border-slate-100 rounded-lg p-2 max-h-20 overflow-y-auto">{parsedData.dailyLog.notes}</span>
                                    </div>
                                )}

                                {parsedData.action === "add_estimate_item" && parsedData.estimateItem && (
                                    <>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-hui-textMuted">Material:</span>
                                            <span className="font-bold text-hui-textMain truncate max-w-[140px]">{parsedData.estimateItem.material}</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-hui-textMuted">Qty / Price:</span>
                                            <span className="font-bold text-hui-textMain">{parsedData.estimateItem.quantity} x ${parsedData.estimateItem.unitPrice}</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-hui-textMuted">Line Total:</span>
                                            <span className="font-bold text-green-600">${(parsedData.estimateItem.quantity * parsedData.estimateItem.unitPrice).toFixed(2)}</span>
                                        </div>
                                    </>
                                )}
                            </div>

                            <div className="flex gap-2 border-t border-slate-100 pt-3">
                                <button
                                    onClick={cancelAction}
                                    className="flex-1 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-xl text-xs font-bold text-slate-600 transition"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={applyAction}
                                    className="flex-1 py-2 bg-gradient-to-tr from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-blue-500/20 flex items-center justify-center gap-1.5"
                                >
                                    Confirm {countdown !== null && `(${countdown})`}
                                </button>
                            </div>
                        </div>
                    )}

                    {status === "success" && (
                        <div className="flex flex-col items-center gap-3 text-center py-4">
                            <div className="w-12 h-12 bg-green-50 rounded-full flex items-center justify-center border border-green-100 shadow-sm animate-bounce">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3"><path d="M20 6 9 17l-5-5"/></svg>
                            </div>
                            <div>
                                <h4 className="font-bold text-hui-textMain">Saved Successfully!</h4>
                                <p className="text-xs text-hui-textMuted mt-1">Refreshed data updates in real-time</p>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Glowing Voice Mic Button */}
            <button
                onClick={isRecording ? stopRecording : startRecording}
                className={`pointer-events-auto flex items-center justify-center w-14 h-14 bg-gradient-to-tr text-white rounded-full shadow-2xl hover:scale-105 active:scale-95 transition group relative ${
                    isRecording 
                        ? "from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800" 
                        : "from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
                }`}
                title="Speak a voice command"
            >
                {/* Ping rings on active recording */}
                {isRecording && (
                    <>
                        <span className="absolute inset-[-4px] rounded-full border border-rose-500/30 animate-pulse" />
                        <span className="absolute inset-0 rounded-full bg-rose-500/25 animate-ping" />
                    </>
                )}
                
                {isRecording ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-pulse"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v1a7 7 0 01-14 0v-1M12 19v4M8 23h8"/></svg>
                )}
            </button>
        </div>
    );
}
