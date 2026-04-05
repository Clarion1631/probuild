import { NextRequest, NextResponse } from 'next/server';
import { calendarOAuth2Client, saveCalendarToken } from '@/lib/calendar-client';

export async function GET(request: NextRequest) {
    const code = request.nextUrl.searchParams.get('code');
    if (!code) {
        return NextResponse.json({ error: 'No code provided' }, { status: 400 });
    }

    try {
        const { tokens } = await calendarOAuth2Client.getToken(code);
        saveCalendarToken(tokens);
        return NextResponse.redirect(new URL('/projects', request.url));
    } catch (error) {
        console.error('Calendar OAuth callback error:', error);
        return NextResponse.json({ error: 'Failed to authenticate' }, { status: 500 });
    }
}
