import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const TOKEN_PATH = path.join(process.cwd(), '.calendar-token.json');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const REDIRECT_URI = process.env.NODE_ENV === 'production'
    ? `https://probuild.goldentouchremodeling.com/api/calendar/callback`
    : 'http://localhost:3000/api/calendar/callback';

export const calendarOAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
);

export function getCalendarAuthUrl() {
    return calendarOAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/calendar'],
        prompt: 'consent',
    });
}

export function loadCalendarToken(): boolean {
    try {
        if (fs.existsSync(TOKEN_PATH)) {
            const token = fs.readFileSync(TOKEN_PATH, 'utf-8');
            calendarOAuth2Client.setCredentials(JSON.parse(token));
            return true;
        }
        if (process.env.GOOGLE_CALENDAR_REFRESH_TOKEN) {
            calendarOAuth2Client.setCredentials({
                refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
            });
            return true;
        }
    } catch (e) {
        console.error('Error loading calendar token:', e);
    }
    return false;
}

export function saveCalendarToken(token: any) {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
    calendarOAuth2Client.setCredentials(token);
}

export function isCalendarAuthed(): boolean {
    return loadCalendarToken();
}

loadCalendarToken();

export const calendar = google.calendar({ version: 'v3', auth: calendarOAuth2Client });
