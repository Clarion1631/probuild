"use client";

import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { useState, useEffect } from 'react';
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ProjectStatus } from "./StatusModals";

interface ProjectsKanbanBoardProps {
    projects: any[];
    statuses: ProjectStatus[];
    onStatusChange: (projectId: string, newStatus: string) => Promise<void>;
    onCustomizeClick: () => void;
}

export default function ProjectsKanbanBoard({ projects: initialProjects, statuses, onStatusChange, onCustomizeClick }: ProjectsKanbanBoardProps) {
    const [projects, setProjects] = useState(initialProjects);
    const [isMounted, setIsMounted] = useState(false);

    useEffect(() => {
        setIsMounted(true);
        setProjects(initialProjects);
    }, [initialProjects]);

    if (!isMounted) return null;

    const onDragEnd = async (result: DropResult) => {
        if (!result.destination) return;
        const { source, destination, draggableId } = result;

        if (source.droppableId === destination.droppableId) return;

        const newStatus = destination.droppableId;
        
        // Optimistic UI Update
        const updatedProjects = projects.map(p => 
            p.id === draggableId ? { ...p, status: newStatus } : p
        );
        setProjects(updatedProjects);

        try {
            await onStatusChange(draggableId, newStatus);
        } catch (e) {
            // Revert on failure
            setProjects(initialProjects);
        }
    };

    return (
        <DragDropContext onDragEnd={onDragEnd}>
            <div className="flex gap-6 pb-8 overflow-x-auto min-h-[500px] items-start">
                {statuses.map(status => {
                    const colProjects = projects.filter((p: any) => (p.status || "Open") === status.value);
                    
                    return (
                        <div key={status.value} className="w-[320px] flex-shrink-0 flex flex-col bg-slate-50 border border-slate-200 rounded-xl overflow-hidden p-3">
                            {/* Column Header */}
                            <div className="flex items-center justify-between mb-4 px-2 pt-1">
                                <h3 className="font-bold text-[14px] flex items-center gap-2 text-slate-800">
                                    <div className="w-2.5 h-2.5 rounded-full shadow-sm" style={{ backgroundColor: status.rawColor }} />
                                    {status.label}
                                    <span className="text-slate-400 font-medium ml-1">({colProjects.length})</span>
                                </h3>
                                <button onClick={onCustomizeClick} className="text-slate-400 hover:text-slate-700 transition">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
                                </button>
                            </div>
                            
                            {/* Drop Zone */}
                            <Droppable droppableId={status.value}>
                                {(provided, snapshot) => (
                                    <div 
                                        {...provided.droppableProps} 
                                        ref={provided.innerRef}
                                        className={`min-h-[150px] space-y-3 rounded-xl transition-colors ${snapshot.isDraggingOver ? 'bg-indigo-50/50' : ''}`}
                                    >
                                        {colProjects.map((project: any, index: number) => (
                                            <Draggable key={project.id} draggableId={project.id} index={index}>
                                                {(provided, snapshot) => (
                                                    <div
                                                        ref={provided.innerRef}
                                                        {...provided.draggableProps}
                                                        {...provided.dragHandleProps}
                                                        className={`block bg-white border border-slate-200 rounded-xl shadow-sm hover:shadow-md transition-all group relative ${snapshot.isDragging ? 'shadow-xl ring-2 ring-indigo-500 ring-opacity-50 z-50 transform rotate-1' : ''}`}
                                                    >
                                                        {/* Color Bar */}
                                                        <div className="absolute left-0 top-0 bottom-0 w-[5px] rounded-l-xl opacity-90" style={{ backgroundColor: project.color || status.rawColor }} />
                                                        
                                                        <Link href={`/projects/${project.id}`} className="block p-5 pl-6">
                                                            {/* Title & Date */}
                                                            <div className="flex justify-between items-start mb-3 gap-2">
                                                                <div className="font-bold text-slate-800 mb-0.5 hover:text-indigo-600 transition-colors text-[15px] leading-tight line-clamp-2">
                                                                    {project.name}
                                                                </div>
                                                                <button 
                                                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); /* Future menu logic */ }}
                                                                    className="text-slate-300 hover:text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity p-1 -mt-1 -mr-1 rounded shrink-0"
                                                                >
                                                                    <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
                                                                </button>
                                                            </div>

                                                            {/* Detail Lines */}
                                                            <div className="flex flex-col gap-2.5">
                                                                {/* Client */}
                                                                <div className="flex items-center gap-2.5">
                                                                    <div className="flex-shrink-0 w-6 h-6 rounded bg-indigo-100 text-indigo-700 flex items-center justify-center text-[10px] font-bold shadow-sm">
                                                                        {(project.client?.name || "U")[0].toUpperCase()}
                                                                    </div>
                                                                    <p className="text-[13px] text-slate-600 font-medium truncate">{project.client?.name || "No Client"}</p>
                                                                </div>

                                                                {/* Location */}
                                                                {project.location && (
                                                                    <div className="flex items-center gap-2.5 text-[13px] text-slate-500">
                                                                        <div className="flex-shrink-0 w-6 flex justify-center text-slate-400">
                                                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                                                                        </div>
                                                                        <span className="truncate">{project.location}</span>
                                                                    </div>
                                                                )}
                                                            </div>
                                                            
                                                            {/* Bottom Bar: Age and Project Type */}
                                                            <div className="flex items-center justify-between mt-5 pt-4 border-t border-slate-100">
                                                                <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                                                                    {project.type || "General"}
                                                                </div>
                                                                <div className="text-[12px] font-medium text-slate-400 bg-slate-50 px-2 py-0.5 rounded">
                                                                    {formatDistanceToNow(new Date(project.createdAt), { addSuffix: true })}
                                                                </div>
                                                            </div>
                                                        </Link>
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
