"use server";

import { prisma } from "./prisma";
import { getSupabase, STORAGE_BUCKET } from "./supabase";
import { createVendor, updateVendor, getVendors } from "./actions";

export async function createVendorWithFiles(payload: any) {
    const { filesToUpload, ...vendorData } = payload;
    
    const v = await createVendor(vendorData);

    if (filesToUpload && filesToUpload.length > 0) {
        await uploadVendorFiles(v.id, filesToUpload);
    }
    
    const finalVendors = await getVendors();
    return { vendors: finalVendors };
}

export async function updateVendorWithFiles(id: string, payload: any) {
    const { filesToUpload, ...vendorData } = payload;
    
    await updateVendor(id, vendorData);

    if (filesToUpload && filesToUpload.length > 0) {
        await uploadVendorFiles(id, filesToUpload);
    }
    
    const finalVendors = await getVendors();
    return { vendors: finalVendors };
}

async function uploadVendorFiles(vendorId: string, files: any[]) {
    const supabase = getSupabase();
    if (!supabase) throw new Error("Storage not configured");

    for (const f of files) {
        // Decode base64 
        // Note: the payload is base64 string
        const buffer = Buffer.from(f.base64Data, "base64");
        
        const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath = `vendors/${vendorId}/${Date.now()}_${safeName}`;
        
        const { error } = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(storagePath, buffer, {
                contentType: f.type || "application/octet-stream",
                upsert: false
            });
            
        if (error) {
            console.error("Vendor File Upload Error:", error);
            continue;
        }

        const { data: urlData } = supabase.storage
            .from(STORAGE_BUCKET)
            .getPublicUrl(storagePath);
            
        await prisma.vendorFile.create({
            data: {
                name: f.name,
                url: urlData?.publicUrl || storagePath,
                size: f.size,
                type: f.type,
                vendorId: vendorId
            }
        });
    }
}
