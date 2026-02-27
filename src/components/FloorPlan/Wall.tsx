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
            startHandleRef.current.position.set(start.x, wall.height / 2, start.z);
        }

        if (endHandleRef.current) {
            endHandleRef.current.position.set(end.x, wall.height / 2, end.z);
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

    return (
        <group ref={groupRef}>
            {/* The Wall Body */}
            <mesh
                ref={bodyRef}
                castShadow
                receiveShadow
                onClick={(e) => {
                    e.stopPropagation(); // Prevent grid click when clicking a wall

                    if (activeTool === 'select') {
                        selectElement(wall.id);
                    } else if (activeTool === 'drawDoor' || activeTool === 'drawWindow') {
                        // Calculate distance from start
                        const distFromStart = Math.sqrt(
                            Math.pow(e.point.x - wall.start.x, 2) + Math.pow(e.point.z - wall.start.z, 2)
                        );

                        addAttachment({
                            type: activeTool === 'drawDoor' ? 'door' : 'window',
                            wallId: wall.id,
                            distanceFromStart: distFromStart,
                            width: activeTool === 'drawDoor' ? 3.0 : 4.0, // Default width
                            height: activeTool === 'drawDoor' ? 6.8 : 4.0, // Default height
                            elevation: activeTool === 'drawDoor' ? 0 : 3.0, // Default elevation (doors on floor, windows at 3ft)
                        });

                        // Switch back to select tool so the user can easily move things
                        useFloorPlanStore.setState({ activeTool: 'select' });
                    }
                }}
                onPointerDown={(e) => {
                    if (activeTool === 'select') {
                        e.stopPropagation();
                        // Select it immediately on mouse down if not already
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
                {/* We use scale on Z to adjust length without modifying vertex array on every frame */}
                <boxGeometry args={[wall.thickness, wall.height, 1]} />
                {/* Visual feedback for selection / hover */}
                <meshStandardMaterial
                    color={isSelected ? "#3b82f6" : hovered ? "#cbd5e1" : "#f1f5f9"}
                    roughness={0.8}
                    emissive={isSelected ? new THREE.Color("#3b82f6") : new THREE.Color("#000000")}
                    emissiveIntensity={isSelected ? 0.2 : 0}
                />

                {/* Length Label Overlay (visible when selected or dragging) */}
                {(isSelected || draggingNode?.elementId === wall.id) && (
                    // Positioned slightly above the wall center
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

            {/* Drag Handles - Only show when selected */}
            {isSelected && (
                <>
                    <mesh
                        ref={startHandleRef}
                        onPointerDown={(e) => {
                            e.stopPropagation();
                            setDraggingNode({ elementId: wall.id, node: 'start' });
                        }}
                    >
                        <cylinderGeometry args={[wall.thickness * 0.8, wall.thickness * 0.8, wall.height + 0.1]} />
                        <meshBasicMaterial color="red" opacity={0.5} transparent />
                    </mesh>
                    <mesh
                        ref={endHandleRef}
                        onPointerDown={(e) => {
                            e.stopPropagation();
                            setDraggingNode({ elementId: wall.id, node: 'end' });
                        }}
                    >
                        <cylinderGeometry args={[wall.thickness * 0.8, wall.thickness * 0.8, wall.height + 0.1]} />
                        <meshBasicMaterial color="red" opacity={0.5} transparent />
                    </mesh>
                </>
            )}
        </group>
    );
}
