"use client";

import { useFloorPlanStore, GenericProduct as ProductType } from "@/store/useFloorPlanStore";
import { useCursor, Html } from "@react-three/drei";
import { useState, useRef, useEffect } from "react";
import * as THREE from "three";

interface GenericProductProps {
    product: ProductType;
}

export default function GenericProductComponent({ product }: GenericProductProps) {
    const { selectedElementId, selectElement, setDraggingNode, activeTool } = useFloorPlanStore();
    const [hovered, setHovered] = useState(false);
    useCursor(hovered, 'pointer', 'auto');

    const groupRef = useRef<THREE.Group>(null);
    const localPosRef = useRef<{ x: number, y: number, z: number }>(product.position);

    useEffect(() => {
        localPosRef.current = product.position;
        if (groupRef.current) {
            groupRef.current.position.set(product.position.x, product.position.y, product.position.z);
        }
    }, [product.position]);

    useEffect(() => {
        const handleUpdate = (e: any) => {
            const { position } = e.detail;
            localPosRef.current = position;
            if (groupRef.current) {
                groupRef.current.position.set(position.x, position.y, position.z);
            }
        };

        const handleCommit = () => {
            useFloorPlanStore.getState().updateProduct(product.id, { position: localPosRef.current });
        };

        window.addEventListener(`update-product-${product.id}`, handleUpdate);
        window.addEventListener(`commit-product-${product.id}`, handleCommit);

        return () => {
            window.removeEventListener(`update-product-${product.id}`, handleUpdate);
            window.removeEventListener(`commit-product-${product.id}`, handleCommit);
        };
    }, [product.id]);

    const isSelected = selectedElementId === product.id;

    const handleRotate = (direction: 'cw' | 'ccw') => {
        const step = Math.PI / 4; // 45 degrees
        const delta = direction === 'cw' ? step : -step;
        useFloorPlanStore.getState().updateProduct(product.id, { rotation: product.rotation + delta });
    };

    // Define colors based on product type
    let color = "#cbd5e1";
    if (product.productType === 'sofa') color = "#94a3b8"; // dark gray
    if (product.productType === 'coffeeTable') color = "#a16207"; // wood
    if (product.productType === 'island') color = "#f8fafc"; // white/gray
    if (product.productType === 'cabinetBase') color = "#e2e8f0"; // light gray

    return (
        <group
            ref={groupRef}
            rotation={[0, product.rotation, 0]}
            onClick={(e) => {
                e.stopPropagation();
                if (activeTool === 'select') {
                    selectElement(product.id);
                }
            }}
            onPointerDown={(e) => {
                if (activeTool === 'select') {
                    e.stopPropagation();
                    if (!isSelected) {
                        selectElement(product.id);
                    }
                    // Use elementId to identify any draggable element in the store
                    setDraggingNode({ elementId: product.id, node: 'center' });
                }
            }}
            onPointerOver={(e) => {
                e.stopPropagation();
                setHovered(true);
            }}
            onPointerOut={() => setHovered(false)}
        >
            {/* The main composite shape representing the product */}
            <group position={[0, product.height / 2, 0]}>
                {product.productType === 'sofa' && (
                    <>
                        {/* Base seat */}
                        <mesh castShadow receiveShadow position={[0, -product.height * 0.2, product.depth * 0.1]}>
                            <boxGeometry args={[product.width, product.height * 0.6, product.depth * 0.8]} />
                            <meshStandardMaterial color={isSelected ? "#3b82f6" : hovered ? "#bae6fd" : color} roughness={0.8} />
                        </mesh>
                        {/* Backrest */}
                        <mesh castShadow receiveShadow position={[0, product.height * 0.1, -product.depth * 0.4]}>
                            <boxGeometry args={[product.width, product.height * 0.8, product.depth * 0.2]} />
                            <meshStandardMaterial color={isSelected ? "#3b82f6" : hovered ? "#bae6fd" : color} roughness={0.8} />
                        </mesh>
                        {/* Armrests */}
                        <mesh castShadow receiveShadow position={[-product.width / 2 + product.width * 0.05, 0, product.depth * 0.1]}>
                            <boxGeometry args={[product.width * 0.1, product.height * 0.8, product.depth * 0.8]} />
                            <meshStandardMaterial color={isSelected ? "#3b82f6" : hovered ? "#bae6fd" : color} roughness={0.8} />
                        </mesh>
                        <mesh castShadow receiveShadow position={[product.width / 2 - product.width * 0.05, 0, product.depth * 0.1]}>
                            <boxGeometry args={[product.width * 0.1, product.height * 0.8, product.depth * 0.8]} />
                            <meshStandardMaterial color={isSelected ? "#3b82f6" : hovered ? "#bae6fd" : color} roughness={0.8} />
                        </mesh>
                    </>
                )}

                {product.productType === 'coffeeTable' && (
                    <>
                        {/* Table top */}
                        <mesh castShadow receiveShadow position={[0, product.height * 0.4, 0]}>
                            <boxGeometry args={[product.width, product.height * 0.2, product.depth]} />
                            <meshStandardMaterial color={isSelected ? "#3b82f6" : hovered ? "#bae6fd" : color} roughness={0.4} />
                        </mesh>
                        {/* Legs */}
                        {[-1, 1].map(x => [-1, 1].map(z => (
                            <mesh key={`${x}-${z}`} castShadow receiveShadow position={[x * product.width * 0.4, -product.height * 0.1, z * product.depth * 0.4]}>
                                <cylinderGeometry args={[0.05, 0.05, product.height * 0.8]} />
                                <meshStandardMaterial color="#333" roughness={0.5} />
                            </mesh>
                        )))}
                    </>
                )}

                {product.productType === 'island' && (
                    <>
                        {/* Base */}
                        <mesh castShadow receiveShadow position={[0, -product.height * 0.05, 0]}>
                            <boxGeometry args={[product.width * 0.9, product.height * 0.9, product.depth * 0.9]} />
                            <meshStandardMaterial color={isSelected ? "#3b82f6" : hovered ? "#bae6fd" : color} roughness={0.8} />
                        </mesh>
                        {/* Countertop */}
                        <mesh castShadow receiveShadow position={[0, product.height * 0.45, 0]}>
                            <boxGeometry args={[product.width, product.height * 0.1, product.depth]} />
                            <meshStandardMaterial color={isSelected ? "#93c5fd" : hovered ? "#bae6fd" : "#f1f5f9"} roughness={0.2} metalness={0.1} />
                        </mesh>
                    </>
                )}

                {product.productType === 'cabinetBase' && (
                    <>
                        {/* Base */}
                        <mesh castShadow receiveShadow position={[0, 0, 0]}>
                            <boxGeometry args={[product.width, product.height, product.depth]} />
                            <meshStandardMaterial color={isSelected ? "#3b82f6" : hovered ? "#bae6fd" : color} roughness={0.8} />
                        </mesh>
                        {/* little handle */}
                        <mesh castShadow receiveShadow position={[0, product.height * 0.3, product.depth * 0.51]}>
                            <boxGeometry args={[product.width * 0.3, 0.05, 0.05]} />
                            <meshStandardMaterial color="#94a3b8" metalness={0.8} roughness={0.2} />
                        </mesh>
                    </>
                )}
            </group>

            {/* Selection Outline + Controls */}
            {isSelected && (
                <>
                    <mesh position={[0, product.height / 2, 0]}>
                        <boxGeometry args={[product.width + 0.1, product.height + 0.1, product.depth + 0.1]} />
                        <meshBasicMaterial color="#3b82f6" wireframe opacity={0.5} transparent />
                    </mesh>

                    {/* 3D Circular Base Controls */}
                    {isSelected && (
                        <group position={[0, 0, 0]}>
                            {/* Dark Ring on floor */}
                            <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                                <ringGeometry args={[Math.max(product.width, product.depth) / 2 + 0.2, Math.max(product.width, product.depth) / 2 + 0.8, 64]} />
                                <meshBasicMaterial color="#334155" transparent opacity={0.6} side={THREE.DoubleSide} />
                            </mesh>

                            {/* Move Left Arrow */}
                            <Html position={[-Math.max(product.width, product.depth) / 2 - 0.5, 0.1, 0]} center zIndexRange={[100, 0]} style={{ pointerEvents: 'auto' }}>
                                <button
                                    onClick={(e) => { e.stopPropagation(); useFloorPlanStore.getState().updateProduct(product.id, { position: { ...product.position, x: product.position.x - 0.5 } }); }}
                                    className="w-8 h-8 hover:scale-110 active:scale-95 transition-transform flex items-center justify-center filter drop-shadow-md cursor-pointer"
                                    title="Move left"
                                >
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="rgba(148, 163, 184, 0.85)" stroke="white" strokeWidth="2" strokeLinejoin="round">
                                        <path d="M 12 4 L 3 12 L 12 20 L 12 15 L 21 15 L 21 9 L 12 9 Z" />
                                    </svg>
                                </button>
                            </Html>

                            {/* Move Right Arrow */}
                            <Html position={[Math.max(product.width, product.depth) / 2 + 0.5, 0.1, 0]} center zIndexRange={[100, 0]} style={{ pointerEvents: 'auto' }}>
                                <button
                                    onClick={(e) => { e.stopPropagation(); useFloorPlanStore.getState().updateProduct(product.id, { position: { ...product.position, x: product.position.x + 0.5 } }); }}
                                    className="w-8 h-8 hover:scale-110 active:scale-95 transition-transform flex items-center justify-center filter drop-shadow-md cursor-pointer"
                                    title="Move right"
                                >
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="rgba(148, 163, 184, 0.85)" stroke="white" strokeWidth="2" strokeLinejoin="round">
                                        <path d="M 12 4 L 21 12 L 12 20 L 12 15 L 3 15 L 3 9 L 12 9 Z" />
                                    </svg>
                                </button>
                            </Html>

                            {/* Move Forward Arrow */}
                            <Html position={[0, 0.1, -Math.max(product.width, product.depth) / 2 - 0.5]} center zIndexRange={[100, 0]} style={{ pointerEvents: 'auto' }}>
                                <button
                                    onClick={(e) => { e.stopPropagation(); useFloorPlanStore.getState().updateProduct(product.id, { position: { ...product.position, z: product.position.z - 0.5 } }); }}
                                    className="w-8 h-8 hover:scale-110 active:scale-95 transition-transform flex items-center justify-center filter drop-shadow-md cursor-pointer"
                                    title="Move forward"
                                >
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="rgba(148, 163, 184, 0.85)" stroke="white" strokeWidth="2" strokeLinejoin="round">
                                        <path d="M 12 4 L 3 12 L 12 20 L 12 15 L 21 15 L 21 9 L 12 9 Z" transform="rotate(90 12 12)" />
                                    </svg>
                                </button>
                            </Html>

                            {/* Move Backward Arrow */}
                            <Html position={[0, 0.1, Math.max(product.width, product.depth) / 2 + 0.5]} center zIndexRange={[100, 0]} style={{ pointerEvents: 'auto' }}>
                                <button
                                    onClick={(e) => { e.stopPropagation(); useFloorPlanStore.getState().updateProduct(product.id, { position: { ...product.position, z: product.position.z + 0.5 } }); }}
                                    className="w-8 h-8 hover:scale-110 active:scale-95 transition-transform flex items-center justify-center filter drop-shadow-md cursor-pointer"
                                    title="Move backward"
                                >
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="rgba(148, 163, 184, 0.85)" stroke="white" strokeWidth="2" strokeLinejoin="round">
                                        <path d="M 12 4 L 3 12 L 12 20 L 12 15 L 21 15 L 21 9 L 12 9 Z" transform="rotate(-90 12 12)" />
                                    </svg>
                                </button>
                            </Html>

                            {/* Rotate CCW */}
                            <Html position={[-Math.max(product.width, product.depth) / 2 - 0.3, 0.1, Math.max(product.width, product.depth) / 2 + 0.3]} center zIndexRange={[100, 0]} style={{ pointerEvents: 'auto' }}>
                                <button
                                    onClick={(e) => { e.stopPropagation(); handleRotate('ccw'); }}
                                    className="w-8 h-8 bg-slate-700/80 rounded-full shadow-md border border-slate-500 flex items-center justify-center hover:bg-slate-600 transition-all text-white cursor-pointer active:scale-90"
                                    title="Rotate left 45°"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M2.5 2v6h6" />
                                        <path d="M2.5 8a10 10 0 0 1 17.13-4" />
                                        <path d="M22 12a10 10 0 0 1-18.37 5.38" />
                                    </svg>
                                </button>
                            </Html>

                            {/* Rotate CW */}
                            <Html position={[Math.max(product.width, product.depth) / 2 + 0.3, 0.1, Math.max(product.width, product.depth) / 2 + 0.3]} center zIndexRange={[100, 0]} style={{ pointerEvents: 'auto' }}>
                                <button
                                    onClick={(e) => { e.stopPropagation(); handleRotate('cw'); }}
                                    className="w-8 h-8 bg-slate-700/80 rounded-full shadow-md border border-slate-500 flex items-center justify-center hover:bg-slate-600 transition-all text-white cursor-pointer active:scale-90"
                                    title="Rotate right 45°"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M21.5 2v6h-6" />
                                        <path d="M21.5 8A10 10 0 0 0 4.37 4" />
                                        <path d="M2 12a10 10 0 0 0 18.37 5.38" />
                                    </svg>
                                </button>
                            </Html>
                        </group>
                    )}
                </>
            )}
        </group>
    );
}
