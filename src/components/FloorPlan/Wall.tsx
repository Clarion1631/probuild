"use client";

import { useFloorPlanStore, Wall as WallType } from "@/store/useFloorPlanStore";
import { useCursor, Html } from "@react-three/drei";
import { useState, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";

interface WallProps {
    wall: WallType;
}

export default function WallComponent({ wall }: WallProps) {
    const { selectedElementId, selectElement, updateWall, setDraggingNode, activeTool, addAttachment, elements, draggingNode } = useFloorPlanStore();
    const [hovered, setHovered] = useState(false);
    useCursor(hovered, 'pointer', 'auto');

    const groupRef = useRef<THREE.Group>(null);
    const bodyRef = useRef<THREE.Mesh>(null);
    const startHandleRef = useRef<THREE.Mesh>(null);
    const endHandleRef = useRef<THREE.Mesh>(null);
    const lengthLabelRef = useRef<HTMLDivElement>(null);
    const localGeomRef = useRef<{ start: { x: number, y: number, z: number }, end: { x: number, y: number, z: number } }>({ start: wall.start, end: wall.end });

    const updateTransforms = useCallback((start: { x: number, y: number, z: number }, end: { x: number, y: number, z: number }) => {
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.sqrt(dx * dx + dz * dz);
        const angle = Math.atan2(dx, dz);

        const mx = (start.x + end.x) / 2;
        const mz = (start.z + end.z) / 2;
        const my = wall.height / 2;

        if (bodyRef.current) {
            bodyRef.current.position.set(mx, my, mz);
            bodyRef.current.rotation.y = angle;
            bodyRef.current.scale.z = length;
        }

        if (lengthLabelRef.current) {
            lengthLabelRef.current.innerText = `${length.toFixed(1)}'`;
        }

        if (startHandleRef.current) {
            startHandleRef.current.position.set(start.x, 0.3, start.z);
        }

        if (endHandleRef.current) {
            endHandleRef.current.position.set(end.x, 0.3, end.z);
        }
    }, [wall.height]);

    // Update local refs seamlessly when react props actually change
    useEffect(() => {
        localGeomRef.current = { start: wall.start, end: wall.end };
        updateTransforms(wall.start, wall.end);
    }, [wall.start, wall.end, wall.height, wall.thickness, updateTransforms]);

    useEffect(() => {
        const handleUpdate = (e: any) => {
            const { start, end } = e.detail;
            localGeomRef.current = { start, end };
            updateTransforms(start, end);
        };

        const handleCommit = () => {
            updateWall(wall.id, { start: localGeomRef.current.start, end: localGeomRef.current.end });
        };

        window.addEventListener(`update-wall-${wall.id}`, handleUpdate);
        window.addEventListener(`commit-wall-${wall.id}`, handleCommit);

        return () => {
            window.removeEventListener(`update-wall-${wall.id}`, handleUpdate);
            window.removeEventListener(`commit-wall-${wall.id}`, handleCommit);
        };
    }, [wall.id, wall.height, updateTransforms, updateWall]);

    const isSelected = selectedElementId === wall.id;

    const nudgeStep = 0.5;
    const handleNudge = (dx: number, dz: number) => {
        updateWall(wall.id, {
            start: { x: wall.start.x + dx, y: wall.start.y, z: wall.start.z + dz },
            end: { x: wall.end.x + dx, y: wall.end.y, z: wall.end.z + dz }
        });
    };

    return (
        <group ref={groupRef}>
            {/* The Wall Body */}
            <mesh
                ref={bodyRef}
                castShadow
                receiveShadow
                onClick={(e) => {
                    e.stopPropagation();

                    if (activeTool === 'select') {
                        selectElement(wall.id);
                    } else if (activeTool === 'drawDoor' || activeTool === 'drawWindow') {
                        const distFromStart = Math.sqrt(
                            Math.pow(e.point.x - wall.start.x, 2) + Math.pow(e.point.z - wall.start.z, 2)
                        );

                        addAttachment({
                            type: activeTool === 'drawDoor' ? 'door' : 'window',
                            wallId: wall.id,
                            distanceFromStart: distFromStart,
                            width: activeTool === 'drawDoor' ? 3.0 : 4.0,
                            height: activeTool === 'drawDoor' ? 6.8 : 4.0,
                            elevation: activeTool === 'drawDoor' ? 0 : 3.0,
                        });

                        useFloorPlanStore.setState({ activeTool: 'select' });
                    }
                }}
                onPointerDown={(e) => {
                    if (activeTool === 'select') {
                        e.stopPropagation();
                        if (!isSelected) {
                            selectElement(wall.id);
                        }
                        setDraggingNode({ elementId: wall.id, node: 'center' });
                    }
                }}
                onPointerOver={(e) => {
                    e.stopPropagation();
                    setHovered(true);
                }}
                onPointerOut={() => setHovered(false)}
            >
                <boxGeometry args={[wall.thickness, wall.height, 1]} />
                <meshStandardMaterial
                    color={isSelected ? "#3b82f6" : hovered ? "#cbd5e1" : "#f1f5f9"}
                    roughness={0.8}
                    emissive={isSelected ? new THREE.Color("#3b82f6") : new THREE.Color("#000000")}
                    emissiveIntensity={isSelected ? 0.2 : 0}
                />

                {/* Length Label Overlay */}
                {(isSelected || draggingNode?.elementId === wall.id) && (
                    <Html position={[0, (wall.height / 2) + 0.5, 0]} center zIndexRange={[100, 0]}>
                        <div
                            ref={lengthLabelRef}
                            className="bg-black/80 text-white px-2 py-1 rounded-md text-xs font-bold whitespace-nowrap pointer-events-none select-none shadow-sm backdrop-blur-sm"
                        >
                            {Math.sqrt(Math.pow(wall.end.x - wall.start.x, 2) + Math.pow(wall.end.z - wall.start.z, 2)).toFixed(1)}'
                        </div>
                    </Html>
                )}
            </mesh>

            {/* Selection UI — only when selected */}
            {isSelected && (
                <>
                    {/* Wireframe outline around the wall */}
                    <mesh
                        position={[
                            (wall.start.x + wall.end.x) / 2,
                            wall.height / 2,
                            (wall.start.z + wall.end.z) / 2
                        ]}
                        rotation={[0, Math.atan2(wall.end.x - wall.start.x, wall.end.z - wall.start.z), 0]}
                    >
                        <boxGeometry args={[
                            wall.thickness + 0.15,
                            wall.height + 0.15,
                            Math.sqrt(Math.pow(wall.end.x - wall.start.x, 2) + Math.pow(wall.end.z - wall.start.z, 2)) + 0.15
                        ]} />
                        <meshBasicMaterial color="#3b82f6" wireframe opacity={0.4} transparent />
                    </mesh>

                    {/* Endpoint handles — small spheres at the base */}
                    <mesh
                        ref={startHandleRef}
                        position={[wall.start.x, 0.3, wall.start.z]}
                        onPointerDown={(e) => {
                            e.stopPropagation();
                            setDraggingNode({ elementId: wall.id, node: 'start' });
                        }}
                    >
                        <sphereGeometry args={[0.35, 16, 16]} />
                        <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={0.4} />
                    </mesh>
                    <mesh
                        ref={endHandleRef}
                        position={[wall.end.x, 0.3, wall.end.z]}
                        onPointerDown={(e) => {
                            e.stopPropagation();
                            setDraggingNode({ elementId: wall.id, node: 'end' });
                        }}
                    >
                        <sphereGeometry args={[0.35, 16, 16]} />
                        <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={0.4} />
                    </mesh>

                    {/* Arrow Nudge Controls — floating above the wall center */}
                    <Html
                        position={[
                            (wall.start.x + wall.end.x) / 2,
                            wall.height + 1.5,
                            (wall.start.z + wall.end.z) / 2
                        ]}
                        center
                        zIndexRange={[100, 0]}
                        style={{ pointerEvents: 'auto' }}
                    >
                        <div
                            className="flex flex-col items-center gap-0.5 select-none"
                            onPointerDown={(e) => e.stopPropagation()}
                        >
                            {/* Up arrow */}
                            <button
                                onClick={(e) => { e.stopPropagation(); handleNudge(0, -nudgeStep); }}
                                className="w-7 h-7 bg-white rounded-full shadow-md border border-slate-200 flex items-center justify-center hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-all text-slate-600 cursor-pointer active:scale-90"
                                title="Move up"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 19V5M5 12l7-7 7 7" />
                                </svg>
                            </button>
                            <div className="flex items-center gap-0.5">
                                {/* Left arrow */}
                                <button
                                    onClick={(e) => { e.stopPropagation(); handleNudge(-nudgeStep, 0); }}
                                    className="w-7 h-7 bg-white rounded-full shadow-md border border-slate-200 flex items-center justify-center hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-all text-slate-600 cursor-pointer active:scale-90"
                                    title="Move left"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M19 12H5M12 5l-7 7 7 7" />
                                    </svg>
                                </button>
                                {/* Center label */}
                                <div className="w-7 h-7 bg-black/75 rounded-full flex items-center justify-center">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M5 9l4-4 4 4M5 15l4 4 4-4" />
                                    </svg>
                                </div>
                                {/* Right arrow */}
                                <button
                                    onClick={(e) => { e.stopPropagation(); handleNudge(nudgeStep, 0); }}
                                    className="w-7 h-7 bg-white rounded-full shadow-md border border-slate-200 flex items-center justify-center hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-all text-slate-600 cursor-pointer active:scale-90"
                                    title="Move right"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M5 12h14M12 5l7 7-7 7" />
                                    </svg>
                                </button>
                            </div>
                            {/* Down arrow */}
                            <button
                                onClick={(e) => { e.stopPropagation(); handleNudge(0, nudgeStep); }}
                                className="w-7 h-7 bg-white rounded-full shadow-md border border-slate-200 flex items-center justify-center hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-all text-slate-600 cursor-pointer active:scale-90"
                                title="Move down"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 5v14M5 12l7 7 7-7" />
                                </svg>
                            </button>
                        </div>
                    </Html>
                </>
            )}
        </group>
    );
}
