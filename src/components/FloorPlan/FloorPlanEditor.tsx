"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useFloorPlanStore } from "@/store/useFloorPlanStore";

import {
    BoxSelect,
    Layers,
    MousePointer2,
    Move,
    Undo,
    Redo,
    Save,
    Share2,
    ArrowLeft
} from "lucide-react";
import Canvas3D from "./Canvas3D";
import Sidebar from "./Sidebar";
import { toast } from "sonner";

interface FloorPlanEditorProps {
    floorPlanId: string;
}

export default function FloorPlanEditor({ floorPlanId }: FloorPlanEditorProps) {
    const router = useRouter();
    const [is3DView, setIs3DView] = useState(true);
    const { activeTool, setActiveTool, selectedElementId, removeElement } = useFloorPlanStore();

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElementId) {
                // Ignore if we're typing in an input field
                if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
                    return;
                }
                removeElement(selectedElementId);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedElementId, removeElement]);

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
                        <button className="p-2 rounded-md text-slate-500 hover:bg-slate-50 hover:text-slate-900 transition"><Undo className="w-4 h-4" /></button>
                        <button className="p-2 rounded-md text-slate-500 hover:bg-slate-50 hover:text-slate-900 transition"><Redo className="w-4 h-4" /></button>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center space-x-3">
                        <button className="flex items-center gap-2 px-3 py-1.5 border border-slate-200 rounded text-sm hover:bg-slate-50 transition text-slate-700">
                            <Share2 className="w-4 h-4" /> Share
                        </button>
                        <button
                            className="flex items-center gap-2 px-3 py-1.5 rounded text-sm bg-slate-900 text-white hover:bg-slate-800 transition shadow-sm"
                            onClick={() => {
                                // Simulate saving to database
                                toast.success("Floor plan saved successfully!");
                            }}
                        >
                            <Save className="w-4 h-4" /> Save
                        </button>
                    </div>
                </header>

                {/* 3D Canvas Context */}
                <div className="flex-1 relative">
                    <Canvas3D is3DView={is3DView} />

                    {/* Floating UI overlays could go here (e.g. tooltips, coordinate displays) */}
                    <div className="absolute bottom-4 left-4 right-4 flex justify-between pointer-events-none">
                        <div className="bg-white/90 backdrop-blur pointer-events-auto px-3 py-1.5 rounded-full shadow-sm text-xs font-medium text-slate-500 border">
                            {is3DView ? 'Perspective View' : 'Orthographic View'} • Drag to rotate/pan
                        </div>
                        <div className="bg-white/90 backdrop-blur pointer-events-auto px-3 py-1.5 rounded-full shadow-sm text-xs font-medium text-slate-500 border flex items-center gap-2">
                            <span>Grid: 1m</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Right Sidebar */}
            <Sidebar />
        </div>
    );
}
