"use client";

// Room Studio - high-res 2D snapshot rendering.
//
// Re-renders the live scene at an upscaled resolution into the existing
// renderer (preserveDrawingBuffer is on), captures a PNG data URL, then
// restores the original size. No second WebGL context needed.

import * as THREE from "three";
import { getCanvasHandles } from "./canvas/StudioCanvas";

export interface SnapshotResult {
  dataUrl: string;
  width: number;
  height: number;
}

export function captureSnapshot(opts?: { width?: number; format?: "png" | "jpeg" }): SnapshotResult | null {
  const handles = getCanvasHandles();
  if (!handles) return null;
  const { gl, camera } = handles;

  const prevSize = new THREE.Vector2();
  gl.getSize(prevSize);
  const prevPixelRatio = gl.getPixelRatio();

  const targetW = opts?.width ?? 2560;
  const aspect = prevSize.x / prevSize.y || 16 / 9;
  const targetH = Math.round(targetW / aspect);

  try {
    gl.setPixelRatio(1);
    gl.setSize(targetW, targetH, false);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = targetW / targetH;
      camera.updateProjectionMatrix();
    }
    // Drive a real R3F frame (not a bare gl.render) so per-frame logic - the
    // camera-facing wall hide especially - applies to the capture.
    handles.advance();
    const dataUrl = opts?.format === "jpeg"
      ? gl.domElement.toDataURL("image/jpeg", 0.92)
      : gl.domElement.toDataURL("image/png");
    return { dataUrl, width: targetW, height: targetH };
  } finally {
    gl.setPixelRatio(prevPixelRatio);
    gl.setSize(prevSize.x, prevSize.y, false);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = prevSize.x / prevSize.y;
      camera.updateProjectionMatrix();
    }
    handles.advance();
  }
}

/** Small JPEG thumbnail for the room list / share cards. */
export function captureThumbnail(width = 640): string | null {
  const handles = getCanvasHandles();
  if (!handles) return null;
  const { gl, camera } = handles;

  const prevSize = new THREE.Vector2();
  gl.getSize(prevSize);
  const prevPixelRatio = gl.getPixelRatio();
  const aspect = prevSize.x / prevSize.y || 16 / 9;
  const h = Math.round(width / aspect);

  try {
    gl.setPixelRatio(1);
    gl.setSize(width, h, false);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = width / h;
      camera.updateProjectionMatrix();
    }
    handles.advance();
    return gl.domElement.toDataURL("image/jpeg", 0.82);
  } finally {
    gl.setPixelRatio(prevPixelRatio);
    gl.setSize(prevSize.x, prevSize.y, false);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = prevSize.x / prevSize.y;
      camera.updateProjectionMatrix();
    }
    handles.advance();
  }
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
