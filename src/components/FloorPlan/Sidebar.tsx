"use client";

import { useState } from "react";

import { Plus, Maximize, MousePointer2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useFloorPlanStore, Wall, WallAttachment, GenericProduct } from "@/store/useFloorPlanStore";

interface SidebarProps {
    // Add props later for selected item properties
}

export default function Sidebar({ }: SidebarProps) {
    const [activeTab, setActiveTab] = useState<"structures" | "products">("structures");
    const { elements, selectedElementId, updateWall, removeElement, activeTool, setActiveTool, updateAttachment, showFloor, setShowFloor, snapEnabled, setSnapEnabled } = useFloorPlanStore();

    const selectedElement = elements.find(el => el.id === selectedElementId);
    const isWallSelected = selectedElement?.type === 'wall';
    const selectedWall = selectedElement as Wall;

    const isAttachmentSelected = selectedElement?.type === 'door' || selectedElement?.type === 'window';
    const selectedAttachment = selectedElement as WallAttachment;

    const isProductSelected = selectedElement?.type === 'product';
    const selectedProduct = selectedElement as GenericProduct;

    let selectedWallLength = 0;
    if (isWallSelected && selectedWall) {
        const dx = selectedWall.end.x - selectedWall.start.x;
        const dz = selectedWall.end.z - selectedWall.start.z;
        selectedWallLength = Math.sqrt(dx * dx + dz * dz);
    }

    return (
        <div className="w-80 bg-white border-l h-full flex flex-col overflow-y-auto">
            {/* Search / Tabs */}
            <div className="p-4 border-b">
                <div className="flex bg-slate-100 rounded-md p-1 mb-4">
                    <button
                        className={`flex-1 text-sm py-1 rounded-sm text-center font-medium ${activeTab === 'structures' ? 'bg-white shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}
                        onClick={() => setActiveTab('structures')}
                    >
                        Structures
                    </button>
                    <button
                        className={`flex-1 text-sm py-1 rounded-sm text-center font-medium ${activeTab === 'products' ? 'bg-white shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}
                        onClick={() => setActiveTab('products')}
                    >
                        Generic Products
                    </button>
                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 p-4">
                {activeTab === 'structures' && (
                    <div className="space-y-6">
                        <div>
                            <div className="flex items-center justify-between mb-3">
                                <h3 className="text-sm font-semibold">
                                    {isWallSelected ? 'Edit Wall' : isAttachmentSelected ? `Edit ${selectedAttachment.type === 'door' ? 'Door' : 'Window'}` : isProductSelected ? 'Edit Product' : 'Walls'}
                                </h3>
                                {selectedElementId && (
                                    <button
                                        onClick={() => removeElement(selectedElementId)}
                                        className="p-1.5 text-red-500 hover:bg-red-50 rounded transition"
                                        title="Delete Selected Element"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                )}
                            </div>
                            <div className="space-y-4">
                                <div>
                                    <label className="text-xs text-slate-500 mb-1 block">
                                        {isWallSelected ? 'Wall Height (ft)' : 'Default Wall Height'}
                                    </label>
                                    <div className="flex items-center space-x-2">
                                        <input
                                            type="number"
                                            step="0.1"
                                            value={isWallSelected ? selectedWall.height : 8.0}
                                            onChange={(e) => {
                                                if (isWallSelected) {
                                                    updateWall(selectedWall.id, { height: parseFloat(e.target.value) || 8.0 });
                                                }
                                            }}
                                            onBlur={() => isWallSelected && toast.success("Wall height saved")}
                                            className="flex-1 border rounded px-2 py-1 text-sm"
                                        />
                                    </div>
                                </div>

                                {isWallSelected && (
                                    <div>
                                        <label className="text-xs text-slate-500 mb-1 block">Wall Length (ft)</label>
                                        <div className="flex items-center space-x-2">
                                            <input
                                                type="number"
                                                step="0.1"
                                                value={parseFloat(selectedWallLength.toFixed(2))}
                                                onChange={(e) => {
                                                    const newLength = parseFloat(e.target.value);
                                                    if (newLength > 0.1 && selectedWall) { // prevent zero/negative
                                                        const dx = selectedWall.end.x - selectedWall.start.x;
                                                        const dz = selectedWall.end.z - selectedWall.start.z;
                                                        const angle = Math.atan2(dz, dx);

                                                        updateWall(selectedWall.id, {
                                                            end: {
                                                                x: selectedWall.start.x + Math.cos(angle) * newLength,
                                                                y: selectedWall.end.y,
                                                                z: selectedWall.start.z + Math.sin(angle) * newLength
                                                            }
                                                        });
                                                    }
                                                }}
                                                onBlur={() => toast.success("Wall length saved")}
                                                className="flex-1 border rounded px-2 py-1 text-sm"
                                            />
                                        </div>
                                    </div>
                                )}

                                <div>
                                    <label className="text-xs text-slate-500 mb-1 block">
                                        {isWallSelected ? 'Wall Thickness (ft)' : 'Default Wall Thickness'}
                                    </label>
                                    <div className="flex items-center space-x-2">
                                        <input
                                            type="number"
                                            step="0.1"
                                            value={isWallSelected ? selectedWall.thickness : 0.5}
                                            onChange={(e) => {
                                                if (isWallSelected) {
                                                    updateWall(selectedWall.id, { thickness: parseFloat(e.target.value) || 0.5 });
                                                }
                                            }}
                                            onBlur={() => isWallSelected && toast.success("Wall thickness saved")}
                                            className="flex-1 border rounded px-2 py-1 text-sm"
                                        />
                                    </div>
                                </div>

                                {isProductSelected && (
                                    <>
                                        <div>
                                            <label className="text-xs text-slate-500 mb-1 block">Width (ft)</label>
                                            <div className="flex items-center space-x-2">
                                                <input
                                                    type="number"
                                                    step="0.1"
                                                    value={selectedProduct.width}
                                                    onChange={(e) => useFloorPlanStore.getState().updateProduct(selectedProduct.id, { width: parseFloat(e.target.value) || 1.0 })}
                                                    onBlur={() => toast.success("Width saved")}
                                                    className="flex-1 border rounded px-2 py-1 text-sm"
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-xs text-slate-500 mb-1 block">Height (ft)</label>
                                            <div className="flex items-center space-x-2">
                                                <input
                                                    type="number"
                                                    step="0.1"
                                                    value={selectedProduct.height}
                                                    onChange={(e) => useFloorPlanStore.getState().updateProduct(selectedProduct.id, { height: parseFloat(e.target.value) || 1.0 })}
                                                    onBlur={() => toast.success("Height saved")}
                                                    className="flex-1 border rounded px-2 py-1 text-sm"
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-xs text-slate-500 mb-1 block">Depth (ft)</label>
                                            <div className="flex items-center space-x-2">
                                                <input
                                                    type="number"
                                                    step="0.1"
                                                    value={selectedProduct.depth}
                                                    onChange={(e) => useFloorPlanStore.getState().updateProduct(selectedProduct.id, { depth: parseFloat(e.target.value) || 1.0 })}
                                                    onBlur={() => toast.success("Depth saved")}
                                                    className="flex-1 border rounded px-2 py-1 text-sm"
                                                />
                                            </div>
                                        </div>
                                        <div className="pt-2">
                                            <button
                                                className="w-full flex items-center justify-center gap-2 px-3 py-1.5 border border-slate-300 rounded text-sm hover:bg-slate-50 transition text-slate-700"
                                                onClick={() => {
                                                    useFloorPlanStore.getState().updateProduct(selectedProduct.id, { rotation: selectedProduct.rotation + Math.PI / 2 });
                                                    toast.success("Product rotated");
                                                }}
                                            >
                                                Rotate 90°
                                            </button>
                                        </div>
                                    </>
                                )}

                                {isAttachmentSelected && (
                                    <>
                                        <div>
                                            <label className="text-xs text-slate-500 mb-1 block">Width (ft)</label>
                                            <div className="flex items-center space-x-2">
                                                <input
                                                    type="number"
                                                    step="0.1"
                                                    value={selectedAttachment.width}
                                                    onChange={(e) => updateAttachment(selectedAttachment.id, { width: parseFloat(e.target.value) || 1.0 })}
                                                    onBlur={() => toast.success("Width saved")}
                                                    className="flex-1 border rounded px-2 py-1 text-sm"
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-xs text-slate-500 mb-1 block">Height (ft)</label>
                                            <div className="flex items-center space-x-2">
                                                <input
                                                    type="number"
                                                    step="0.1"
                                                    value={selectedAttachment.height}
                                                    onChange={(e) => updateAttachment(selectedAttachment.id, { height: parseFloat(e.target.value) || 1.0 })}
                                                    onBlur={() => toast.success("Height saved")}
                                                    className="flex-1 border rounded px-2 py-1 text-sm"
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-xs text-slate-500 mb-1 block">Elevation (ft)</label>
                                            <div className="flex items-center space-x-2">
                                                <input
                                                    type="number"
                                                    step="0.1"
                                                    value={selectedAttachment.elevation}
                                                    onChange={(e) => updateAttachment(selectedAttachment.id, { elevation: parseFloat(e.target.value) || 0 })}
                                                    onBlur={() => toast.success("Elevation saved")}
                                                    className="flex-1 border rounded px-2 py-1 text-sm"
                                                />
                                            </div>
                                        </div>
                                        <div className="pt-2">
                                            <button
                                                className="w-full flex items-center justify-center gap-2 px-3 py-1.5 border border-slate-300 rounded text-sm hover:bg-slate-50 transition text-slate-700"
                                                onClick={() => {
                                                    updateAttachment(selectedAttachment.id, { isFlipped: !selectedAttachment.isFlipped });
                                                    toast.success("Element flipped");
                                                }}
                                            >
                                                Flip / Rotate 180°
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>

                        <div className="pt-4 border-t">
                            <h3 className="text-sm font-semibold mb-3">Doors & Windows</h3>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    className={`h-20 flex flex-col items-center justify-center space-y-2 border rounded-md transition ${activeTool === 'drawDoor' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-slate-200 hover:bg-slate-50'}`}
                                    onClick={() => setActiveTool('drawDoor')}
                                >
                                    <span className={`w-8 h-4 border-2 rounded-sm ${activeTool === 'drawDoor' ? 'border-current' : 'border-slate-400'}`}></span>
                                    <span className="text-xs">Single Door</span>
                                </button>
                                <button
                                    className={`h-20 flex flex-col items-center justify-center space-y-2 border rounded-md transition ${activeTool === 'drawWindow' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-slate-200 hover:bg-slate-50'}`}
                                    onClick={() => setActiveTool('drawWindow')}
                                >
                                    <span className={`w-8 h-8 border-2 rounded-sm ${activeTool === 'drawWindow' ? 'border-current' : 'border-slate-400'}`}></span>
                                    <span className="text-xs">Window</span>
                                </button>
                            </div>
                        </div>

                        <div className="pt-4 border-t">
                            <h3 className="text-sm font-semibold mb-3">Settings</h3>
                            <div className="space-y-2">
                                <label className="flex items-center space-x-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={showFloor}
                                        onChange={(e) => setShowFloor(e.target.checked)}
                                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                    />
                                    <span className="text-sm text-slate-700">Display Generic Floor Surface</span>
                                </label>
                                <label className="flex items-center space-x-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={snapEnabled}
                                        onChange={(e) => setSnapEnabled(e.target.checked)}
                                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                    />
                                    <span className="text-sm text-slate-700">Enable Object Snapping</span>
                                </label>
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'products' && (
                    <div className="space-y-6">
                        <div className="pt-2">
                            <h3 className="text-sm font-semibold mb-3">Living Room</h3>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    className={`h-20 flex flex-col items-center justify-center space-y-2 border rounded-md transition ${activeTool === 'drawProduct_sofa' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-slate-200 hover:bg-slate-50 text-slate-500'}`}
                                    onClick={() => setActiveTool('drawProduct_sofa')}
                                >
                                    <div className="w-8 h-8 rounded bg-slate-200 border border-slate-300"></div>
                                    <span className="text-xs">Sofa</span>
                                </button>
                                <button
                                    className={`h-20 flex flex-col items-center justify-center space-y-2 border rounded-md transition ${activeTool === 'drawProduct_coffeeTable' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-slate-200 hover:bg-slate-50 text-slate-500'}`}
                                    onClick={() => setActiveTool('drawProduct_coffeeTable')}
                                >
                                    <div className="w-8 h-8 rounded bg-slate-200 border border-slate-300"></div>
                                    <span className="text-xs">Coffee Table</span>
                                </button>
                            </div>
                        </div>
                        <div className="pt-4 border-t">
                            <h3 className="text-sm font-semibold mb-3">Kitchen</h3>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    className={`h-20 flex flex-col items-center justify-center space-y-2 border rounded-md transition ${activeTool === 'drawProduct_island' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-slate-200 hover:bg-slate-50 text-slate-500'}`}
                                    onClick={() => setActiveTool('drawProduct_island')}
                                >
                                    <div className="w-8 h-8 rounded bg-slate-200 border border-slate-300"></div>
                                    <span className="text-xs">Island</span>
                                </button>
                                <button
                                    className={`h-20 flex flex-col items-center justify-center space-y-2 border rounded-md transition ${activeTool === 'drawProduct_cabinetBase' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-slate-200 hover:bg-slate-50 text-slate-500'}`}
                                    onClick={() => setActiveTool('drawProduct_cabinetBase')}
                                >
                                    <div className="w-8 h-8 rounded bg-slate-200 border border-slate-300"></div>
                                    <span className="text-xs">Cabinet Base</span>
                                </button>
                            </div>
                        </div>

                        <div className="pt-4 border-t flex flex-col items-center justify-center text-slate-500 space-y-4">
                            <p className="text-xs text-center px-4">Need something specific? Import a custom 3D model.</p>
                            <button className="flex items-center px-3 py-1.5 border border-slate-300 rounded text-sm hover:bg-slate-50 transition text-slate-900">
                                <Plus className="w-4 h-4 mr-2" /> Upload GLB
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
