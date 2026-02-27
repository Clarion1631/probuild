"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useFloorPlanStore } from "@/store/useFloorPlanStore";
import { getFloorPlan, saveFloorPlanData } from "@/lib/actions";

import {
    BoxSelect,
    Layers,
    MousePointer2,
    Move,
    Undo,
    Redo,
    Save,
    Share2,
    ArrowLeft,
    Loader2
} from "lucide-react";
import Canvas3D from "./Canvas3D";
import Sidebar from "./Sidebar";
import { toast } from "sonner";

interface FloorPlanEditorProps {
    floorPlanId: string;
    projectId: string;
}

export default function FloorPlanEditor({ floorPlanId, projectId }: FloorPlanEditorProps) {
    const router = useRouter();
    const [is3DView, setIs3DView] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const { activeTool, setActiveTool, selectedElementId, removeElement, undo, redo, loadElements, getSerializableState, past, future } = useFloorPlanStore();

    // Load floor plan data on mount
    useEffect(() => {
        async function load() {
            try {
                const floorPlan = await getFloorPlan(floorPlanId);
                if (floorPlan?.data) {
                    const elements = JSON.parse(floorPlan.data);
                    loadElements(elements);
                }
            } catch (err) {
                console.error("Failed to load floor plan:", err);
            } finally {
                setIsLoading(false);
            }
        }
        load();
    }, [floorPlanId, loadElements]);

    // Keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if we're typing in an input field
            if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
                return;
            }

            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElementId) {
                removeElement(selectedElementId);
            }

            // Undo: Ctrl+Z / Cmd+Z
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                undo();
            }

            // Redo: Ctrl+Shift+Z / Cmd+Shift+Z or Ctrl+Y
            if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') ||
                ((e.ctrlKey || e.metaKey) && e.key === 'y')) {
                e.preventDefault();
                redo();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedElementId, removeElement, undo, redo]);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const data = getSerializableState();
            await saveFloorPlanData(floorPlanId, projectId, data);
            toast.success("Floor plan saved successfully!");
        } catch (err) {
            console.error("Failed to save floor plan:", err);
            toast.error("Failed to save floor plan");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="flex h-screen w-full bg-slate-50 overflow-hidden text-slate-900">

            {/* Main Canvas Area */}
            <div className="flex-1 flex flex-col min-w-0 bg-[#f8f9fa]">

                {/* Top Navigation & Toolbar */}
                <header className="h-16 bg-white border-b flex items-center justify-between px-4 shrink-0 z-10 shadow-sm">

                    <div className="flex items-center space-x-4">
                        <h1 className="font-semibold text-lg text-slate-800 tracking-tight flex items-center gap-2">
                            <button
                                onClick={() => router.back()}
                                className="p-1 hover:bg-slate-100 rounded-md transition-colors mr-1 cursor-pointer text-slate-500 hover:text-slate-900"
                                title="Go Back"
                            >
                                <ArrowLeft className="w-5 h-5" />
                            </button>
                            <span className="bg-blue-100 text-blue-700 p-1.5 rounded-md">
                                <Layers className="w-5 h-5" />
                            </span>
                            Floor Plan Editor
                        </h1>
                        <div className="h-6 w-px bg-slate-200"></div>

                        {/* View Toggles */}
                        <div className="bg-slate-100 p-1 rounded-md flex space-x-1">
                            <button
                                onClick={() => setIs3DView(false)}
                                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${!is3DView ? 'bg-white shadow text-slate-900' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'}`}
                            >
                                2D Plan
                            </button>
                            <button
                                onClick={() => setIs3DView(true)}
                                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors flex items-center gap-1.5 ${is3DView ? 'bg-white shadow text-blue-600' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'}`}
                            >
                                <BoxSelect className="w-4 h-4" /> 3D View
                            </button>
                        </div>
                    </div>

                    {/* Tools */}
                    <div className="flex items-center space-x-2">
                        <button
                            className={`p-2 rounded-md transition ${activeTool === 'select' ? "bg-slate-100 text-blue-600" : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"}`}
                            onClick={() => setActiveTool('select')}
                        >
                            <MousePointer2 className="w-4 h-4" />
                        </button>
                        <button
                            className={`px-3 py-1.5 rounded-md text-sm transition ${activeTool === 'drawWall' ? "bg-slate-100 text-blue-600" : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"}`}
                            onClick={() => setActiveTool('drawWall')}
                        >
                            Draw Wall
                        </button>
                        <div className="h-4 w-px bg-slate-200 mx-2"></div>
                        <button
                            className={`p-2 rounded-md transition ${past.length === 0 ? 'text-slate-300 cursor-not-allowed' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
                            onClick={undo}
                            disabled={past.length === 0}
                            title="Undo (Ctrl+Z)"
                        >
                            <Undo className="w-4 h-4" />
                        </button>
                        <button
                            className={`p-2 rounded-md transition ${future.length === 0 ? 'text-slate-300 cursor-not-allowed' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
                            onClick={redo}
                            disabled={future.length === 0}
                            title="Redo (Ctrl+Shift+Z)"
                        >
                            <Redo className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center space-x-3">
                        <button className="flex items-center gap-2 px-3 py-1.5 border border-slate-200 rounded text-sm hover:bg-slate-50 transition text-slate-700">
                            <Share2 className="w-4 h-4" /> Share
                        </button>
                        <button
                            className="flex items-center gap-2 px-3 py-1.5 rounded text-sm bg-slate-900 text-white hover:bg-slate-800 transition shadow-sm disabled:opacity-50"
                            onClick={handleSave}
                            disabled={isSaving}
                        >
                            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            {isSaving ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </header>

                {/* 3D Canvas Context */}
                <div className="flex-1 relative">
                    {isLoading ? (
                        <div className="flex items-center justify-center h-full">
                            <div className="flex flex-col items-center gap-3 text-slate-400">
                                <Loader2 className="w-8 h-8 animate-spin" />
                                <span className="text-sm font-medium">Loading floor plan…</span>
                            </div>
                        </div>
                    ) : (
                        <Canvas3D is3DView={is3DView} />
                    )}

                    {/* Floating UI overlays could go here (e.g. tooltips, coordinate displays) */}
                    {!isLoading && (
                        <div className="absolute bottom-4 left-4 right-4 flex justify-between pointer-events-none">
                            <div className="bg-white/90 backdrop-blur pointer-events-auto px-3 py-1.5 rounded-full shadow-sm text-xs font-medium text-slate-500 border">
                                {is3DView ? 'Perspective View' : 'Orthographic View'} • Drag to {is3DView ? 'rotate/pan' : 'pan'}
                            </div>
                            <div className="bg-white/90 backdrop-blur pointer-events-auto px-3 py-1.5 rounded-full shadow-sm text-xs font-medium text-slate-500 border flex items-center gap-2">
                                <span>Grid: 1m</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Right Sidebar */}
            <Sidebar />
        </div>
    );
}
