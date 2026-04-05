import { NextResponse } from 'next/server';
import { isCalendarAuthed } from '@/lib/calendar-client';

export async function GET() {
    return NextResponse.json({ connected: isCalendarAuthed() });
}
