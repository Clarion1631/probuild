"use client";

import { useFloorPlanStore, WallAttachment, Wall } from "@/store/useFloorPlanStore";
import { useCursor, Html } from "@react-three/drei";
import { useState, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";

interface DoorWindowProps {
    attachment: WallAttachment;
    parentWall: Wall;
}

export default function DoorWindow({ attachment, parentWall }: DoorWindowProps) {
    const { selectedElementId, selectElement, updateAttachment, setDraggingNode } = useFloorPlanStore();
    const [hovered, setHovered] = useState(false);
    useCursor(hovered, 'pointer', 'auto');
    const meshRef = useRef<THREE.Mesh>(null);
    const localGeomRef = useRef<{ distanceFromStart: number }>({ distanceFromStart: attachment.distanceFromStart });

    const isSelected = selectedElementId === attachment.id;

    const updateTransforms = useCallback((dist: number, flipped: boolean = false) => {
        const dx = parentWall.end.x - parentWall.start.x;
        const dz = parentWall.end.z - parentWall.start.z;
        const wallLength = Math.sqrt(dx * dx + dz * dz);
        const angle = Math.atan2(dx, dz);

        const dirX = wallLength === 0 ? 0 : dx / wallLength;
        const dirZ = wallLength === 0 ? 0 : dz / wallLength;

        const posX = parentWall.start.x + dirX * dist;
        const posZ = parentWall.start.z + dirZ * dist;
        const posY = attachment.elevation + (attachment.height / 2);

        if (meshRef.current) {
            meshRef.current.position.set(posX, posY, posZ);
            meshRef.current.rotation.y = angle + (flipped ? Math.PI : 0);
        }
    }, [parentWall, attachment.elevation, attachment.height]);

    // Update local refs seamlessly when react props actually change
    useEffect(() => {
        localGeomRef.current = { distanceFromStart: attachment.distanceFromStart };
        updateTransforms(attachment.distanceFromStart, attachment.isFlipped);
    }, [attachment.distanceFromStart, parentWall, attachment.isFlipped, updateTransforms]);

    useEffect(() => {
        const handleUpdate = (e: any) => {
            const { distanceFromStart } = e.detail;
            localGeomRef.current = { distanceFromStart };
            updateTransforms(distanceFromStart, attachment.isFlipped);
        };

        const handleCommit = () => {
            updateAttachment(attachment.id, { distanceFromStart: localGeomRef.current.distanceFromStart });
        };

        window.addEventListener(`update-attachment-${attachment.id}`, handleUpdate);
        window.addEventListener(`commit-attachment`, handleCommit); // Using a global commit hook for active objects

        return () => {
            window.removeEventListener(`update-attachment-${attachment.id}`, handleUpdate);
            window.removeEventListener(`commit-attachment`, handleCommit);
        };
    }, [attachment.id, parentWall, updateTransforms, updateAttachment]);

    const isDoor = attachment.type === 'door';

    // Slightly thicker than the wall to prevent Z-fighting and look like a frame/cutout
    const depth = parentWall.thickness * 1.1;

    const handleFlip = () => {
        updateAttachment(attachment.id, { isFlipped: !attachment.isFlipped });
    };

    return (
        <group>
            <mesh
                ref={meshRef}
                castShadow
                onClick={(e) => {
                    e.stopPropagation();
                    selectElement(attachment.id);
                }}
                onPointerDown={(e) => {
                    if (isSelected) {
                        e.stopPropagation();
                        setDraggingNode({ elementId: attachment.id, node: 'center' });
                    }
                }}
                onPointerOver={(e) => {
                    e.stopPropagation();
                    setHovered(true);
                }}
                onPointerOut={() => setHovered(false)}
            >
                <boxGeometry args={[depth, attachment.height, attachment.width]} />

                <meshStandardMaterial
                    color={
                        isSelected ? "#3b82f6"
                            : hovered ? (isDoor ? "#8B4513" : "#87CEEB")
                                : (isDoor ? "#A0522D" : "#ADD8E6")
                    }
                    transparent={!isDoor}
                    opacity={isDoor ? 1 : 0.6}
                    roughness={isDoor ? 0.7 : 0.1}
                    metalness={isDoor ? 0.1 : 0.8}
                    emissive={isSelected ? new THREE.Color("#3b82f6") : new THREE.Color("#000000")}
                    emissiveIntensity={isSelected ? 0.3 : 0}
                />

                {/* Controls — slide arrows + flip button */}
                {isSelected && (
                    <Html
                        position={[0, (attachment.height / 2) + 0.8, 0]}
                        center
                        zIndexRange={[100, 0]}
                        style={{ pointerEvents: 'auto' }}
                    >
                        <div
                            className="flex items-center gap-1 select-none"
                            onPointerDown={(e) => e.stopPropagation()}
                        >
                            {/* Slide left along wall */}
                            <button
                                onClick={(e) => { e.stopPropagation(); updateAttachment(attachment.id, { distanceFromStart: Math.max(0, attachment.distanceFromStart - 0.5) }); }}
                                className="w-7 h-7 bg-white rounded-full shadow-md border border-slate-200 flex items-center justify-center hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-all text-slate-600 cursor-pointer active:scale-90"
                                title="Slide left along wall"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M19 12H5M12 5l-7 7 7 7" />
                                </svg>
                            </button>
                            {/* Flip button */}
                            <button
                                onClick={(e) => { e.stopPropagation(); handleFlip(); }}
                                className="h-7 bg-white rounded-full shadow-md border border-slate-200 flex items-center justify-center gap-1.5 px-2.5 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-all text-slate-600 cursor-pointer active:scale-90 text-[11px] font-semibold whitespace-nowrap"
                                title={`Flip ${isDoor ? 'door' : 'window'} direction`}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M7 16V4l-4 4" />
                                    <path d="M17 8v12l4-4" />
                                </svg>
                                Flip
                            </button>
                            {/* Slide right along wall */}
                            <button
                                onClick={(e) => { e.stopPropagation(); updateAttachment(attachment.id, { distanceFromStart: attachment.distanceFromStart + 0.5 }); }}
                                className="w-7 h-7 bg-white rounded-full shadow-md border border-slate-200 flex items-center justify-center hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-all text-slate-600 cursor-pointer active:scale-90"
                                title="Slide right along wall"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M5 12h14M12 5l7 7-7 7" />
                                </svg>
                            </button>
                        </div>
                    </Html>
                )}
            </mesh>
        </group>
    );
}
