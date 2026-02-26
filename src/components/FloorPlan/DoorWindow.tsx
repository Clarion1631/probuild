"use client";

import { useFloorPlanStore, WallAttachment, Wall } from "@/store/useFloorPlanStore";
import { useCursor } from "@react-three/drei";
import { useState, useRef, useEffect } from "react";
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

    // Update local refs seamlessly when react props actually change
    useEffect(() => {
        localGeomRef.current = { distanceFromStart: attachment.distanceFromStart };
        updateTransforms(attachment.distanceFromStart, attachment.isFlipped);
    }, [attachment.distanceFromStart, parentWall, attachment.isFlipped]);

    const updateTransforms = (dist: number, flipped: boolean = false) => {
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
    };

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
    }, [attachment.id, parentWall]);

    const isDoor = attachment.type === 'door';

    // Slightly thicker than the wall to prevent Z-fighting and look like a frame/cutout
    const depth = parentWall.thickness * 1.1;

    return (
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
                    setDraggingNode({ wallId: attachment.id, node: 'center' }); // wallId is actually elementId
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
        </mesh>
    );
}
