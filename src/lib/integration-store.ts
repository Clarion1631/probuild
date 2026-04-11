/**
 * Integration settings storage via Supabase Storage.
 * Stores OAuth tokens and settings for QB, Gusto, etc. as a private JSON file.
 * Single-tenant: one file per workspace.
 */
import { getSupabase, STORAGE_BUCKET } from "./supabase";

const SETTINGS_PATH = "system/integration-settings.json";

export interface QBSettings {
    connected: boolean;
    accessToken?: string;
    refreshToken?: string;
    realmId?: string;
    connectedAt?: string;
    glMappings?: Record<string, string>; // costCodeId → QB GL account name
}

export interface GustoSettings {
    connected: boolean;
    accessToken?: string;
    refreshToken?: string;
    companyId?: string;
    connectedAt?: string;
    employeeMappings?: Record<string, string>; // userId → gusto_employee_uuid
}

export interface IntegrationSettings {
    quickbooks?: QBSettings;
    gusto?: GustoSettings;
}

async function readSettings(): Promise<IntegrationSettings> {
    const sb = getSupabase();
    if (!sb) return {};
    try {
        const { data, error } = await sb.storage.from(STORAGE_BUCKET).download(SETTINGS_PATH);
        if (error || !data) return {};
        const text = await data.text();
        return JSON.parse(text) as IntegrationSettings;
    } catch {
        return {};
    }
}

async function writeSettings(settings: IntegrationSettings): Promise<void> {
    const sb = getSupabase();
    if (!sb) return;
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
    await sb.storage.from(STORAGE_BUCKET).upload(SETTINGS_PATH, blob, { upsert: true });
}

export async function getIntegrationSettings(): Promise<IntegrationSettings> {
    return readSettings();
}

export async function getQBSettings(): Promise<QBSettings> {
    const settings = await readSettings();
    return settings.quickbooks || { connected: false };
}

export async function saveQBSettings(qb: Partial<QBSettings>): Promise<void> {
    const settings = await readSettings();
    settings.quickbooks = { ...(settings.quickbooks || { connected: false }), ...qb };
    await writeSettings(settings);
}

export async function getGustoSettings(): Promise<GustoSettings> {
    const settings = await readSettings();
    return settings.gusto || { connected: false };
}

export async function saveGustoSettings(gusto: Partial<GustoSettings>): Promise<void> {
    const settings = await readSettings();
    settings.gusto = { ...(settings.gusto || { connected: false }), ...gusto };
    await writeSettings(settings);
}
