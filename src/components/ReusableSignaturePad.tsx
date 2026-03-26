"use client";

import { useRef, useState, useEffect } from "react";

interface SignaturePadProps {
    onSignatureChange: (dataUrl: string | null) => void;
    width?: number;
    height?: number;
}

export default function SignaturePad({ onSignatureChange, width = 500, height = 200 }: SignaturePadProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [hasDrawn, setHasDrawn] = useState(false);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Set up high-DPI canvas
        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        ctx.scale(dpr, dpr);

        // Style
        ctx.strokeStyle = "#1a1a1a";
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        // Draw signature line
        ctx.beginPath();
        ctx.strokeStyle = "#e2e8f0";
        ctx.lineWidth = 1;
        ctx.moveTo(20, height - 40);
        ctx.lineTo(width - 20, height - 40);
        ctx.stroke();

        // "X" marker
        ctx.font = "16px serif";
        ctx.fillStyle = "#94a3b8";
        ctx.fillText("✕", 8, height - 34);

        // Reset for drawing
        ctx.strokeStyle = "#1a1a1a";
        ctx.lineWidth = 2.5;
    }, [width, height]);

    function getPos(e: React.MouseEvent | React.TouchEvent) {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();

        if ("touches" in e) {
            return {
                x: e.touches[0].clientX - rect.left,
                y: e.touches[0].clientY - rect.top
            };
        }
        return {
            x: (e as React.MouseEvent).clientX - rect.left,
            y: (e as React.MouseEvent).clientY - rect.top
        };
    }

    function startDrawing(e: React.MouseEvent | React.TouchEvent) {
        e.preventDefault();
        const ctx = canvasRef.current?.getContext("2d");
        if (!ctx) return;
        const pos = getPos(e);
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
        setIsDrawing(true);
    }

    function draw(e: React.MouseEvent | React.TouchEvent) {
        e.preventDefault();
        if (!isDrawing) return;
        const ctx = canvasRef.current?.getContext("2d");
        if (!ctx) return;
        const pos = getPos(e);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
        setHasDrawn(true);
    }

    function stopDrawing() {
        if (!isDrawing) return;
        setIsDrawing(false);
        if (hasDrawn && canvasRef.current) {
            onSignatureChange(canvasRef.current.toDataURL("image/png"));
        }
    }

    function clear() {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Redraw signature line
        ctx.save();
        ctx.strokeStyle = "#e2e8f0";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(20, height - 40);
        ctx.lineTo(width - 20, height - 40);
        ctx.stroke();

        ctx.font = "16px serif";
        ctx.fillStyle = "#94a3b8";
        ctx.fillText("✕", 8, height - 34);
        ctx.restore();

        // Reset for drawing
        ctx.strokeStyle = "#1a1a1a";
        ctx.lineWidth = 2.5;

        setHasDrawn(false);
        onSignatureChange(null);
    }

    return (
        <div className="space-y-2">
            <div className="border-2 border-dashed border-slate-300 rounded-lg bg-white overflow-hidden cursor-crosshair relative">
                <canvas
                    ref={canvasRef}
                    onMouseDown={startDrawing}
                    onMouseMove={draw}
                    onMouseUp={stopDrawing}
                    onMouseLeave={stopDrawing}
                    onTouchStart={startDrawing}
                    onTouchMove={draw}
                    onTouchEnd={stopDrawing}
                    className="touch-none"
                />
                {!hasDrawn && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <p className="text-slate-400 text-sm">Draw your signature here</p>
                    </div>
                )}
            </div>
            <div className="flex justify-between items-center">
                <p className="text-xs text-hui-textMuted">
                    Use your mouse, trackpad, or finger to sign
                </p>
                {hasDrawn && (
                    <button
                        onClick={clear}
                        type="button"
                        className="text-xs text-red-500 hover:text-red-700 font-medium transition"
                    >
                        Clear Signature
                    </button>
                )}
            </div>
        </div>
    );
}
