"use client";

import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { useState, useEffect } from 'react';
import Avatar from "@/components/Avatar";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { updateLeadStage, convertLeadToProject } from "@/lib/actions";

const STAGES = ["New", "Followed Up", "Connected", "Estimate Sent", "Won", "Closed"];

const STAGE_COLORS: Record<string, string> = {
    "New": "border-blue-500",
    "Followed Up": "border-purple-500",
    "Connected": "border-yellow-500",
    "Estimate Sent": "border-orange-500",
    "Won": "border-green-500",
    "Closed": "border-slate-500"
};

export default function KanbanBoard({ initialLeads }: { initialLeads: any[] }) {
    const [leads, setLeads] = useState(initialLeads);
    // hydration fix for dnd
    const [isMounted, setIsMounted] = useState(false);

    useEffect(() => {
        setIsMounted(true);
        setLeads(initialLeads);
    }, [initialLeads]);

    if (!isMounted) return null;

    const onDragEnd = async (result: DropResult) => {
        if (!result.destination) return;
        const { source, destination, draggableId } = result;

        if (source.droppableId === destination.droppableId) return;

        const newStage = destination.droppableId;
        
        // Optimistic update
        const updatedLeads = leads.map(l => 
            l.id === draggableId ? { ...l, stage: newStage } : l
        );
        setLeads(updatedLeads);

        try {
            await updateLeadStage(draggableId, newStage);
        } catch (e) {
            // Revert on failure
            setLeads(initialLeads);
        }
    };

    const handleConvertToProject = async (e: React.MouseEvent, leadId: string) => {
        e.preventDefault();
        e.stopPropagation();
        if (!confirm("Are you sure you want to convert this lead to a project?")) return;
        try {
            const { id } = await convertLeadToProject(leadId);
            window.location.href = `/projects/${id}`;
        } catch (error) {
            console.error(error);
            alert("Failed to convert lead to project.");
        }
    };

    return (
        <DragDropContext onDragEnd={onDragEnd}>
            <div className="flex gap-6 p-6 bg-slate-50/50 overflow-x-auto min-h-[500px]">
                {STAGES.map(stage => {
                    const stageLeads = leads.filter((l: any) => l.stage === stage);
                    const totalRevenue = stageLeads.reduce((sum, l) => sum + (l.targetRevenue || 0), 0);
                    
                    return (
                        <div key={stage} className="w-80 flex-shrink-0 flex flex-col gap-4">
                            <div className="flex flex-col gap-1 px-1">
                                <div className="flex items-center justify-between">
                                    <h3 className="font-semibold text-slate-800 text-sm tracking-tight">{stage}</h3>
                                    <span className="bg-white/60 border border-slate-200 text-slate-600 text-xs px-2.5 py-1 rounded-full shadow-sm font-medium">{stageLeads.length}</span>
                                </div>
                                {totalRevenue > 0 && (
                                    <div className="text-xs text-slate-500 font-medium">
                                        ${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                    </div>
                                )}
                            </div>
                            
                            <Droppable droppableId={stage}>
                                {(provided, snapshot) => (
                                    <div 
                                        {...provided.droppableProps} 
                                        ref={provided.innerRef}
                                        className={`min-h-[200px] space-y-3 rounded-xl transition-colors ${snapshot.isDraggingOver ? 'bg-slate-200/50' : ''}`}
                                    >
                                        {stageLeads.map((l: any, index: number) => (
                                            <Draggable key={l.id} draggableId={l.id} index={index}>
                                                {(provided, snapshot) => (
                                                    <div
                                                        ref={provided.innerRef}
                                                        {...provided.draggableProps}
                                                        {...provided.dragHandleProps}
                                                        className={`block bg-white border border-slate-200 rounded-xl shadow-sm hover:shadow-md transition-all group relative border-l-4 ${STAGE_COLORS[l.stage] || 'border-slate-500'} ${snapshot.isDragging ? 'shadow-lg ring-2 ring-blue-500 ring-opacity-50 z-50' : ''}`}
                                                    >
                                                        <Link href={`/leads/${l.id}`} className="block p-5 content-wrapper">
                                                            <div className="font-semibold text-blue-600 mb-2 hover:underline text-sm truncate">{l.name}</div>
                                                            <div className="flex items-center gap-2 mb-3">
                                                                <div className="flex-shrink-0 h-6 w-6">
                                                                    <Avatar name={l.client?.name || "Unknown"} color="blue" />
                                                                </div>
                                                                <p className="text-xs text-slate-700 font-medium truncate">{l.client?.name || "Unknown Client"}</p>
                                                            </div>
                                                            
                                                            <div className="flex flex-col gap-1.5 mt-2">
                                                                {l.targetRevenue ? (
                                                                    <div className="text-xs font-semibold text-green-700 bg-green-50 w-fit px-2 py-0.5 rounded">
                                                                        ${l.targetRevenue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                                                    </div>
                                                                ) : null}
                                                                <div className="flex items-center justify-between mt-1">
                                                                    <div className="text-[11px] text-slate-500">
                                                                        {formatDistanceToNow(new Date(l.updatedAt || l.createdAt), { addSuffix: true })}
                                                                    </div>
                                                                    {l.estimates && l.estimates.length > 0 && (
                                                                        <div className="text-[11px] text-slate-500 flex items-center gap-1">
                                                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                                                            {l.estimates.length}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </Link>
                                                        
                                                        {/* Quick Actions (Hover) */}
                                                        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-1 bg-white/95 backdrop-blur shadow-sm border border-slate-100 rounded-md p-1 z-10 pointer-events-auto">
                                                            {/* We use buttons passing location.href or stopping propagation to not trigger link wrap */}
                                                            <button 
                                                                title="Create Estimate" 
                                                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = `/leads/${l.id}`; /* Assuming estimate creation is better done securely via modal or page inside lead */ }}
                                                                className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded"
                                                            >
                                                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                                                            </button>
                                                            <button 
                                                                title="Schedule Meeting" 
                                                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = `/leads/${l.id}/meetings`; }}
                                                                className="p-1.5 text-slate-500 hover:text-purple-600 hover:bg-purple-50 rounded"
                                                            >
                                                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                                                            </button>
                                                            <button 
                                                                title="Convert to Project" 
                                                                onClick={(e) => handleConvertToProject(e, l.id)}
                                                                className="p-1.5 text-slate-500 hover:text-green-600 hover:bg-green-50 rounded"
                                                            >
                                                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}
                                            </Draggable>
                                        ))}
                                        {provided.placeholder}
                                    </div>
                                )}
                            </Droppable>
                        </div>
                    );
                })}
            </div>
        </DragDropContext>
    );
}
