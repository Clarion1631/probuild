import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const TOKEN_PATH = path.join(process.cwd(), '.gmail-token.json');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Support both local dev and production on Vercel
const REDIRECT_URI = process.env.NODE_ENV === 'production'
    ? `https://probuild.goldentouchremodeling.com/api/gmail/callback` 
    : 'http://localhost:3000/api/gmail/callback';

export const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
);

export function getAuthUrl() {
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/gmail.send'
        ],
        prompt: 'consent' // Forces refresh token generation
    });
}

export function loadToken() {
    try {
        if (fs.existsSync(TOKEN_PATH)) {
            const token = fs.readFileSync(TOKEN_PATH, 'utf-8');
            oauth2Client.setCredentials(JSON.parse(token));
            return true;
        }
        
        // Also check if token was passed via ENV for Vercel production
        if (process.env.GMAIL_REFRESH_TOKEN) {
            oauth2Client.setCredentials({
                refresh_token: process.env.GMAIL_REFRESH_TOKEN
            });
            return true;
        }
    } catch (e) {
        console.error("Error loading gmail token:", e);
    }
    return false;
}

export function saveToken(token: any) {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
    oauth2Client.setCredentials(token);
}

// Ensure token is loaded when file is imported so backend functions have Auth Context
loadToken();

export const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
