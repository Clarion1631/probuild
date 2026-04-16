// Offscreen PNG export for the Room Designer.
//
// CRITICAL: This file NEVER resizes the live <Canvas> renderer, and NEVER
// routes the pixel path through EffectComposer. Doing either would:
//   - invalidate the composer's render targets (visible flash / black frame)
//   - cause R3F's useFrame loop to observe a size mismatch
//   - leak GPU memory if the resize happens mid-frame
// Instead we render into a fresh WebGLRenderTarget sized to the export
// dimensions, read pixels off the GPU, and composite the watermark onto a
// 2D <canvas> before returning a PNG Blob.
//
// Why this beats html2canvas:
//   html2canvas rasterizes the DOM — for WebGL it reads pixels from the
//   default framebuffer, which is subject to `preserveDrawingBuffer` and is
//   only ever at the LIVE canvas resolution. We want 2048² regardless of
//   screen size, and we want the pixel path isolated from the live scene.

import * as THREE from "three";

export interface RenderPngOpts {
    width: number;
    height: number;
    /** Optional watermark drawn after the 3D render. Pass null to skip. */
    watermark?: {
        contractor: string;
        project: string;
    } | null;
    /**
     * Optional background clear color (hex or "transparent"). Defaults to
     * the live scene's background. Export flows usually pass a light cool
     * neutral so the PDF/PNG doesn't bleed into the sheet.
     */
    clearColor?: string;
}

/**
 * Renders `scene` from `camera`'s POV into a 2048²-class PNG blob.
 *
 * Safe to call with the SAME renderer that drives the live Canvas — the
 * renderer is restored to its prior render target, clear color, and size
 * before returning.
 */
export async function renderRoomPng(
    gl: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    opts: RenderPngOpts,
): Promise<Blob> {
    const { width, height } = opts;

    // 1) Save renderer state we are about to mutate. This is the whole reason
    //    this works without disturbing the live scene.
    const prevTarget = gl.getRenderTarget();
    const prevClear = gl.getClearColor(new THREE.Color()).getHex();
    const prevClearAlpha = gl.getClearAlpha();
    const prevSize = new THREE.Vector2();
    gl.getSize(prevSize);
    const prevPixelRatio = gl.getPixelRatio();
    const prevAutoClear = gl.autoClear;
    const prevScissorTest = gl.getScissorTest();

    // 2) Build an offscreen render target at the desired resolution.
    //    UnsignedByteType matches what a PNG can store; anything more is
    //    just thrown away by the encode step.
    const target = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.UnsignedByteType,
        // ACESFilmic expects linear input. drei's Environment drives this
        // on the renderer, and we inherit it via `gl.outputColorSpace`.
        colorSpace: THREE.SRGBColorSpace,
    });

    // 3) Clone the camera so updating aspect/frustum doesn't touch the live
    //    CameraRig. We update projection on the clone and render.
    const cameraClone = camera.clone();
    if (cameraClone instanceof THREE.PerspectiveCamera) {
        cameraClone.aspect = width / height;
        cameraClone.updateProjectionMatrix();
    } else if (cameraClone instanceof THREE.OrthographicCamera) {
        // Preserve the caller's ortho bounds — they've already set them.
        cameraClone.updateProjectionMatrix();
    }

    try {
        // 4) Configure renderer for the offscreen pass.
        gl.setPixelRatio(1); // offscreen should be 1:1, we sized the target exactly
        gl.setSize(width, height, false); // `false` = don't update canvas CSS
        gl.setRenderTarget(target);
        gl.autoClear = true;
        if (opts.clearColor && opts.clearColor !== "transparent") {
            gl.setClearColor(new THREE.Color(opts.clearColor), 1);
        } else {
            gl.setClearColor(new THREE.Color(prevClear), opts.clearColor === "transparent" ? 0 : prevClearAlpha);
        }

        // 5) The render. One synchronous draw call — no useFrame, no composer.
        gl.render(scene, cameraClone);

        // 6) Pull pixels off the GPU into a CPU buffer.
        const pixels = new Uint8Array(width * height * 4);
        gl.readRenderTargetPixels(target, 0, 0, width, height, pixels);

        // 7) Hand off to 2D canvas for Y-flip + watermark.
        return await pixelsToPng(pixels, width, height, opts.watermark ?? null);
    } finally {
        // 8) RESTORE. Order matters: setRenderTarget before setSize so the
        //    size change is applied to the default framebuffer path.
        gl.setRenderTarget(prevTarget);
        gl.setPixelRatio(prevPixelRatio);
        gl.setSize(prevSize.x, prevSize.y, false);
        gl.setClearColor(new THREE.Color(prevClear), prevClearAlpha);
        gl.autoClear = prevAutoClear;
        gl.setScissorTest(prevScissorTest);
        target.dispose();
    }
}

/** Y-flip the GL pixel buffer, composite watermark, return a PNG Blob. */
function pixelsToPng(
    pixels: Uint8Array,
    width: number,
    height: number,
    watermark: RenderPngOpts["watermark"],
): Promise<Blob> {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");

    // WebGL's origin is bottom-left; 2D canvas is top-left. Build ImageData
    // directly from the flipped buffer so we don't pay a second draw.
    const image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
        const srcRow = (height - 1 - y) * width * 4;
        const dstRow = y * width * 4;
        // One row at a time — faster than per-pixel JS loops.
        image.data.set(pixels.subarray(srcRow, srcRow + width * 4), dstRow);
    }
    ctx.putImageData(image, 0, 0);

    if (watermark) {
        const pad = Math.round(width * 0.014); // scales with export resolution
        const fontSize = Math.round(width * 0.009);
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = "#ffffff";
        ctx.font = `600 ${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
        ctx.textBaseline = "top";
        // Contractor name — top-right
        ctx.textAlign = "right";
        ctx.fillText(watermark.contractor, width - pad, pad);
        // Project name — bottom-right
        ctx.textBaseline = "bottom";
        ctx.fillText(watermark.project, width - pad, height - pad);
        ctx.globalAlpha = 1;
    }

    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) reject(new Error("canvas.toBlob failed"));
            else resolve(blob);
        }, "image/png");
    });
}

/** Trigger a browser download of a blob with the given filename. */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke on the next tick — some browsers are racy on immediate revoke.
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

/** Slugify a name for use in an export filename. */
export function slugifyForFilename(s: string): string {
    return s
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .toLowerCase()
        .slice(0, 60) || "room";
}
