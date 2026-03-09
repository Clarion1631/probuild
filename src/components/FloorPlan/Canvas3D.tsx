"use client";

import { Canvas, ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Grid, Sky, Environment, Loader, OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import { useState, useRef, useEffect, Suspense } from "react";
import { useFloorPlanStore, WallAttachment, Wall, GenericProduct as ProductType, PRODUCT_DEFAULTS } from "@/store/useFloorPlanStore";
import WallComponent from "./Wall";
import DoorWindow from "./DoorWindow";
import GenericProduct from "./GenericProduct";
import * as THREE from "three";

interface Canvas3DProps {
    is3DView: boolean;
}

export default function Canvas3D({ is3DView }: Canvas3DProps) {
    const { elements, activeTool, draftWallStart, setDraftWallStart, addWall, selectElement, draggingNode, setDraggingNode, updateWall, updateAttachment, showFloor, snapEnabled } = useFloorPlanStore();

    // We use a local ref to track the "pending" position of dragged items without triggering React renders 60 times a second
    const localDragState = useRef<{
        elementId: string;
        node: 'start' | 'end' | 'center' | 'rotate';
        startHoverPoint: THREE.Vector3 | null;
        originalStart: { x: number, y: number, z: number };
        originalEnd: { x: number, y: number, z: number };
    } | null>(null);

    // Initialize local drag state when Zustand registers a drag start
    useEffect(() => {
        if (draggingNode) {
            const el = elements.find(e => e.id === draggingNode.elementId);
            if (el?.type === 'wall') {
                const wall = el as Wall;
                localDragState.current = {
                    ...draggingNode,
                    startHoverPoint: null,
                    originalStart: { ...wall.start },
                    originalEnd: { ...wall.end }
                };
            } else if (el?.type === 'product') {
                const prod = el as ProductType;
                localDragState.current = {
                    ...draggingNode,
                    startHoverPoint: null,
                    originalStart: { ...prod.position }, // Reusing originalStart as originalPosition
                    originalEnd: { x: 0, y: 0, z: 0 }
                };
            }
        } else {
            localDragState.current = null;
        }
    }, [draggingNode, elements]);

    const getSnappedPoint = (point: THREE.Vector3 | { x: number, y: number, z: number }, ignoreWallId?: string) => {
        if (!snapEnabled) {
            return { x: point.x, y: 0, z: point.z };
        }

        const snapDistance = 0.5;
        for (const el of elements) {
            if (el.type !== 'wall' || el.id === ignoreWallId) continue;

            // Check start point
            const dxStart = point.x - el.start.x;
            const dzStart = point.z - el.start.z;
            if (Math.sqrt(dxStart * dxStart + dzStart * dzStart) < snapDistance) return { ...el.start };

            // Check end point
            const dxEnd = point.x - el.end.x;
            const dzEnd = point.z - el.end.z;
            if (Math.sqrt(dxEnd * dxEnd + dzEnd * dzEnd) < snapDistance) return { ...el.end };
        }
        // Snap to grid
        return { x: Math.round(point.x * 2) / 2, y: 0, z: Math.round(point.z * 2) / 2 };
    };

    const handleGridClick = (e: ThreeEvent<MouseEvent>) => {
        if (activeTool === 'select') {
            selectElement(null);
            return;
        }

        if (activeTool === 'drawWall') {
            const snappedPoint = getSnappedPoint(e.point);

            if (!draftWallStart) {
                setDraftWallStart(snappedPoint);
            } else {
                addWall(draftWallStart, snappedPoint);
                setDraftWallStart(null);
            }
            return;
        }

        if (activeTool.startsWith('drawProduct_')) {
            const productType = activeTool.replace('drawProduct_', '') as keyof typeof PRODUCT_DEFAULTS;
            const defaults = PRODUCT_DEFAULTS[productType] ?? { width: 2, height: 2, depth: 2 };

            useFloorPlanStore.getState().addProduct({
                type: 'product',
                productType,
                position: { x: e.point.x, y: 0, z: e.point.z },
                rotation: 0,
                width: defaults.width,
                height: defaults.height,
                depth: defaults.depth
            });

            // Revert back to select tool so they can immediately drag it
            useFloorPlanStore.getState().setActiveTool('select');
        }
    };

    const handlePointerMove = (e: ThreeEvent<MouseEvent>) => {
        if (!draggingNode || !localDragState.current) return;

        const state = localDragState.current;
        const draggedElement = elements.find(el => el.id === state.elementId);
        if (!draggedElement) return;

        if (draggedElement.type === 'wall') {
            const wall = draggedElement as Wall;
            // When center dragging, we calculate the delta from the initial pointer down
            if (state.node === 'center') {
                if (!state.startHoverPoint) {
                    state.startHoverPoint = e.point.clone();
                }

                const dx = e.point.x - state.startHoverPoint.x;
                const dz = e.point.z - state.startHoverPoint.z;

                const newStart = { x: state.originalStart.x + dx, y: 0, z: state.originalStart.z + dz };
                const newEnd = { x: state.originalEnd.x + dx, y: 0, z: state.originalEnd.z + dz };

                // Apply direct mutation to the group via a global ref registry (implemented in Wall.tsx)
                const groupEvent = new CustomEvent(`update-wall-${wall.id}`, { detail: { start: newStart, end: newEnd } });
                window.dispatchEvent(groupEvent);
            } else {
                // Snapping for endpoints
                const newPoint = getSnappedPoint(e.point, state.elementId);
                const newStart = state.node === 'start' ? newPoint : state.originalStart;
                const newEnd = state.node === 'end' ? newPoint : state.originalEnd;

                const groupEvent = new CustomEvent(`update-wall-${wall.id}`, { detail: { start: newStart, end: newEnd } });
                window.dispatchEvent(groupEvent);
            }
        } else if (draggedElement.type === 'door' || draggedElement.type === 'window') {
            const attachment = draggedElement as WallAttachment;
            const parentWall = elements.find(el => el.id === attachment.wallId) as Wall;
            if (parentWall) {
                // Project cursor point onto the wall segment
                // A = parentWall.start, B = parentWall.end, P = e.point
                const dx = parentWall.end.x - parentWall.start.x;
                const dz = parentWall.end.z - parentWall.start.z;
                const wallLengthSq = dx * dx + dz * dz;

                if (wallLengthSq > 0) {
                    // Dot product to find projection length (t) along the wall vector
                    let t = ((e.point.x - parentWall.start.x) * dx + (e.point.z - parentWall.start.z) * dz) / wallLengthSq;

                    // Clamp t between 0 and 1 so it doesn't slide off the wall
                    t = Math.max(0, Math.min(1, t));

                    const distFromStart = t * Math.sqrt(wallLengthSq);

                    // Dispatch custom event to DoorWindow component
                    const attachmentEvent = new CustomEvent(`update-attachment-${attachment.id}`, { detail: { distanceFromStart: distFromStart } });
                    window.dispatchEvent(attachmentEvent);
                }
            }
        } else if (draggedElement.type === 'product') {
            const product = draggedElement as ProductType;
            if (state.node === 'rotate') {
                // Calculate rotation based on center of product to pointer
                const dx = e.point.x - product.position.x;
                const dz = e.point.z - product.position.z;

                // Keep the rotation smooth, atan2 works well here
                let angle = Math.atan2(dx, dz);

                // Optional: Snap to 45 deg if shift keys are down, otherwise free rotate.
                // We'll just free-rotate for now to match intuitive dragging.

                const groupEvent = new CustomEvent(`update-product-${draggedElement.id}`, { detail: { rotation: angle } });
                window.dispatchEvent(groupEvent);
            } else {
                // Standard center translation dragging
                if (!state.startHoverPoint) {
                    state.startHoverPoint = e.point.clone();
                }

                const dx = e.point.x - state.startHoverPoint.x;
                const dz = e.point.z - state.startHoverPoint.z;

                // Preserve existing elevation/Y value
                const y = product.position.y ?? 0;

                const newPos = { x: state.originalStart.x + dx, y: y, z: state.originalStart.z + dz };

                const groupEvent = new CustomEvent(`update-product-${draggedElement.id}`, { detail: { position: newPos } });
                window.dispatchEvent(groupEvent);
            }
        }
    };

    const handlePointerUp = () => {
        if (draggingNode && localDragState.current) {
            // Commit final position to Zustand
            const state = localDragState.current;
            const elementId = state.elementId;
            const element = elements.find(el => el.id === elementId);

            if (element?.type === 'product') {
                window.dispatchEvent(new CustomEvent(`commit-product-${elementId}`));
            } else if (state.node === 'center' || state.node === 'start' || state.node === 'end') {
                window.dispatchEvent(new CustomEvent(`commit-wall-${elementId}`));
            } else {
                window.dispatchEvent(new CustomEvent(`commit-attachment`));
            }
            setDraggingNode(null);
        }
    };

    return (
        <div className="w-full h-full bg-slate-50 relative">
            <Canvas
                shadows
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
            >
                <Suspense fallback={null}>
                    {/* Cameras — orthographic for 2D, perspective for 3D */}
                    {is3DView ? (
                        <PerspectiveCamera makeDefault position={[10, 10, 10]} fov={50} />
                    ) : (
                        <OrthographicCamera makeDefault position={[0, 20, 0]} zoom={30} near={0.1} far={100} />
                    )}

                    {/* Lighting */}
                    <ambientLight intensity={0.5} />
                    <directionalLight
                        castShadow
                        position={[10, 20, 10]}
                        intensity={1.5}
                        shadow-mapSize={[2048, 2048]}
                        shadow-bias={-0.001}
                    />
                    <Environment preset="city" />

                    {/* Environment */}
                    {is3DView && <Sky sunPosition={[100, 20, 100]} />}

                    {/* Ground Grid */}
                    <Grid
                        renderOrder={-1}
                        position={[0, -0.01, 0]}
                        infiniteGrid
                        fadeDistance={50}
                        fadeStrength={5}
                        cellSize={1}
                        sectionSize={5}
                    />

                    {/* Controls */}
                    <OrbitControls
                        makeDefault
                        enabled={!draggingNode}
                        enablePan={true}
                        enableDamping={true}
                        dampingFactor={0.05}
                        minDistance={is3DView ? 2 : undefined}
                        maxDistance={is3DView ? 50 : undefined}
                        minZoom={is3DView ? undefined : 10}
                        maxZoom={is3DView ? undefined : 100}
                        maxPolarAngle={is3DView ? Math.PI / 2 - 0.05 : 0} // Prevent looking completely from below in 3D, force top-down in 2D
                        enableRotate={is3DView}
                    />

                    {/* Interactive Plane for drawing/clicking/dragging */}
                    <mesh
                        rotation={[-Math.PI / 2, 0, 0]}
                        position={[0, -0.001, 0]}
                        receiveShadow
                        onClick={handleGridClick}
                        onPointerMove={handlePointerMove}
                        visible={true}
                    >
                        <planeGeometry args={[100, 100]} />
                        <meshBasicMaterial color="#000" wireframe opacity={0} transparent />
                    </mesh>

                    {/* Render Scene Elements */}
                    {showFloor && (
                        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
                            <planeGeometry args={[50, 50]} />
                            <meshStandardMaterial color="#E2DCD3" roughness={0.9} />
                        </mesh>
                    )}

                    {elements.map((el) => {
                        if (el.type === 'wall') return <WallComponent key={el.id} wall={el as Wall} />;
                        if (el.type === 'product') return <GenericProduct key={el.id} product={el as ProductType} />;
                        if (el.type === 'door' || el.type === 'window') {
                            const parentWall = elements.find(w => w.id === el.wallId) as Wall;
                            if (parentWall) {
                                return <DoorWindow key={el.id} attachment={el} parentWall={parentWall} />;
                            }
                        }
                        return null;
                    })}

                    {/* Render In-Progress Draft Wall */}
                    {draftWallStart && activeTool === 'drawWall' && (
                        <mesh position={[draftWallStart.x, 0.1, draftWallStart.z]}>
                            <sphereGeometry args={[0.2]} />
                            <meshBasicMaterial color="red" />
                        </mesh>
                    )}
                </Suspense>
            </Canvas>
            {/* Loading indicator shown outside the canvas while 3D assets load */}
            <Loader />
        </div>
    );
}
