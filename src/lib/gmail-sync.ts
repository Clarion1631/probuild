import { gmail } from './gmail-client';
import { prisma } from './prisma';

export async function syncPurchaseOrderEmails(purchaseOrderCode: string, purchaseOrderId: string) {
    try {
        // Query Gmail for messages sent to our group inbox containing the PO code
        // e.g. "PO-105" in subject or body
        const query = `${purchaseOrderCode} to:purchaseorders@goldentouchremodeling.com OR from:purchaseorders@goldentouchremodeling.com`;
        
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: query,
        });

        const messages = response.data.messages || [];
        
        for (const msg of messages) {
            if (!msg.id) continue;

            // Check if we already synced this message to prevent duplicates
            const existing = await prisma.purchaseOrderMessage.findUnique({
                where: { gmailMessageId: msg.id }
            });

            if (existing) continue; // Skip

            // Fetch full message details
            const msgDetails = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id,
                format: 'full'
            });

            const payload = msgDetails.data.payload;
            if (!payload || !payload.headers) continue;

            // Extract headers
            const subjectHeader = payload.headers.find(h => h.name === 'Subject')?.value || '';
            const fromHeader = payload.headers.find(h => h.name === 'From')?.value || '';
            
            // Basic parsing of sender
            let senderEmail = fromHeader;
            let senderName = '';
            const match = fromHeader.match(/(.*)<(.*)>/);
            if (match) {
                senderName = match[1].trim();
                senderEmail = match[2].trim();
            }

            // Determine if it was inbound (vendor) or outbound (team)
            const isOutbound = senderEmail.includes('goldentouchremodeling.com');
            const senderType = isOutbound ? "TEAM" : "VENDOR";

            // Extract body (simplified)
            let body = '';
            let attachmentUrl = null;
            let isAttachment = false;

            if (payload.parts) {
                const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
                if (textPart && textPart.body && textPart.body.data) {
                    body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
                }
                
                // Identify first image attachment
                const imagePart = payload.parts.find(p => p.mimeType?.startsWith('image/'));
                if (imagePart && imagePart.filename && imagePart.body && imagePart.body.attachmentId) {
                    isAttachment = true;
                    // Because we don't have a live S3 bucket configured for raw API, we'll store a placeholder or DataURI 
                    // To feed to AI, we must fetch the attachment binary
                    const attachData = await gmail.users.messages.attachments.get({
                        userId: 'me',
                        messageId: msg.id,
                        id: imagePart.body.attachmentId
                    });
                    
                    if (attachData.data.data) {
                        try {
                            const { GoogleGenAI } = await import("@google/genai");
                            const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
                            
                            const aiResponse = await ai.models.generateContent({
                                model: "gemini-3-flash-preview",
                                contents: [
                                    "You are an automated logistics bot parsing a delivery document. Does this image look like a delivery ticket or material receipt? If so, simply list what was received.",
                                    { inlineData: { data: attachData.data.data as string, mimeType: imagePart.mimeType || "image/jpeg" } }
                                ]
                            });
                            
                            if (aiResponse.text) {
                                // We auto append the AI findings to the body!
                                body += `\n\n[AUTO-AI SCAN of ${imagePart.filename}]: ${aiResponse.text}`;
                            }
                        } catch (e) {
                            console.error("AI Attachment Parse failed:", e);
                        }
                    }
                }

            } else if (payload.body && payload.body.data) {
                body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
            }

            // Save basic message
            await prisma.purchaseOrderMessage.create({
                data: {
                    purchaseOrderId,
                    gmailMessageId: msg.id,
                    body: body || "(No plain text body)",
                    senderEmail,
                    senderName,
                    senderType,
                    isAttachment
                }
            });
        }
        
        return { success: true, count: messages.length };
    } catch (error) {
        console.error("Failed to sync PO emails:", error);
        return { success: false, error };
    }
}
