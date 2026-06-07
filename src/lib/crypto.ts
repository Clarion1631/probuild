import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

// Derive a 256-bit key from the secret
function getEncryptionKey(): Buffer {
    const SECRET = process.env.NEXTAUTH_SECRET;
    if (!SECRET) {
        throw new Error("NEXTAUTH_SECRET must be set for encryption.");
    }
    return crypto.createHash("sha256").update(SECRET).digest();
}

/**
 * Encrypts a plain object into an encrypted hex string.
 * Format of the returned string: iv_hex:ciphertext_hex:auth_tag_hex
 */
export function encryptObject(obj: any): string {
    const text = JSON.stringify(obj);
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    
    const authTag = cipher.getAuthTag().toString("hex");
    const ivHex = iv.toString("hex");
    
    return `${ivHex}:${encrypted}:${authTag}`;
}

/**
 * Decrypts an encrypted hex string (iv_hex:ciphertext_hex:auth_tag_hex) back to a plain object.
 */
export function decryptObject(encryptedText: string): any {
    if (!encryptedText) return null;
    
    const parts = encryptedText.split(":");
    if (parts.length !== 3) {
        throw new Error("Invalid encrypted format. Expected iv:ciphertext:tag");
    }
    
    const [ivHex, ciphertextHex, authTagHex] = parts;
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(ciphertextHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    
    return JSON.parse(decrypted);
}
