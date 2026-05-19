/**
 * Integration settings storage via an encrypted PostgreSQL table.
 * Stores OAuth tokens and settings for QB, Gusto, etc. securely.
 * Utilizes a Prisma transaction and AES-256-GCM encryption.
 */
import { prisma } from "./prisma";
import { encryptObject, decryptObject } from "./crypto";

export interface QBSettings {
    connected: boolean;
    accessToken?: string;
    refreshToken?: string;
    realmId?: string;
    connectedAt?: string;
    glMappings?: Record<string, string>; // costCodeId -> QB GL account name
}

export interface GustoSettings {
    connected: boolean;
    accessToken?: string;
    refreshToken?: string;
    companyId?: string;
    connectedAt?: string;
    employeeMappings?: Record<string, string>; // userId -> gusto_employee_uuid
}

export interface IntegrationSettings {
    quickbooks?: QBSettings;
    gusto?: GustoSettings;
}

// Single row ID for storing all system integrations safely
const INTEGRATION_ROW_ID = "system_settings";

async function readSettings(): Promise<IntegrationSettings> {
    try {
        const row = await prisma.integration.findUnique({
            where: { id: INTEGRATION_ROW_ID }
        });
        if (!row || !row.settings) return {};
        return decryptObject(row.settings) as IntegrationSettings;
    } catch (err) {
        console.error("Error reading integration settings:", err);
        return {};
    }
}

async function writeSettings(settings: IntegrationSettings): Promise<void> {
    const encrypted = encryptObject(settings);
    try {
        await prisma.integration.upsert({
            where: { id: INTEGRATION_ROW_ID },
            create: { id: INTEGRATION_ROW_ID, settings: encrypted },
            update: { settings: encrypted }
        });
    } catch (err) {
        console.error("Error writing integration settings:", err);
    }
}

export async function getIntegrationSettings(): Promise<IntegrationSettings> {
    return readSettings();
}

export async function getQBSettings(): Promise<QBSettings> {
    const settings = await readSettings();
    return settings.quickbooks || { connected: false };
}

export async function saveQBSettings(qb: Partial<QBSettings>): Promise<void> {
    // Safe transaction to prevent race conditions during concurrent token updates
    await prisma.$transaction(async (tx) => {
        const row = await tx.integration.findUnique({
            where: { id: INTEGRATION_ROW_ID }
        });
        const settings: IntegrationSettings = row && row.settings 
            ? decryptObject(row.settings) 
            : {};
        
        settings.quickbooks = { ...(settings.quickbooks || { connected: false }), ...qb };
        const encrypted = encryptObject(settings);
        
        await tx.integration.upsert({
            where: { id: INTEGRATION_ROW_ID },
            create: { id: INTEGRATION_ROW_ID, settings: encrypted },
            update: { settings: encrypted }
        });
    });
}

export async function getGustoSettings(): Promise<GustoSettings> {
    const settings = await readSettings();
    return settings.gusto || { connected: false };
}

export async function saveGustoSettings(gusto: Partial<GustoSettings>): Promise<void> {
    // Safe transaction to prevent race conditions during concurrent token updates
    await prisma.$transaction(async (tx) => {
        const row = await tx.integration.findUnique({
            where: { id: INTEGRATION_ROW_ID }
        });
        const settings: IntegrationSettings = row && row.settings 
            ? decryptObject(row.settings) 
            : {};
        
        settings.gusto = { ...(settings.gusto || { connected: false }), ...gusto };
        const encrypted = encryptObject(settings);
        
        await tx.integration.upsert({
            where: { id: INTEGRATION_ROW_ID },
            create: { id: INTEGRATION_ROW_ID, settings: encrypted },
            update: { settings: encrypted }
        });
    });
}
