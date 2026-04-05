import { NextRequest, NextResponse } from 'next/server';
import { calendar, isCalendarAuthed } from '@/lib/calendar-client';
import prisma from '@/lib/prisma';

export async function POST(request: NextRequest) {
    if (!isCalendarAuthed()) {
        return NextResponse.json({ error: 'Google Calendar not connected. Please authorize first.' }, { status: 401 });
    }

    try {
        const { projectId } = await request.json();
        if (!projectId) {
            return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
        }

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { name: true },
        });

        const tasks = await prisma.scheduleTask.findMany({
            where: { projectId },
            orderBy: { order: 'asc' },
        });

        if (tasks.length === 0) {
            return NextResponse.json({ error: 'No tasks to sync' }, { status: 400 });
        }

        const calendarName = `ProBuild: ${project?.name || 'Project'}`;

        // Find or create a ProBuild-specific calendar
        let targetCalendarId = 'primary';
        try {
            const calendarList = await calendar.calendarList.list();
            const existing = calendarList.data.items?.find(
                (c) => c.summary === calendarName
            );
            if (existing?.id) {
                targetCalendarId = existing.id;
            } else {
                const created = await calendar.calendars.insert({
                    requestBody: { summary: calendarName, description: `Schedule for ${project?.name || 'project'} — synced from ProBuild` },
                });
                if (created.data.id) targetCalendarId = created.data.id;
            }
        } catch {
            // Fall back to primary calendar
        }

        let synced = 0;
        let errors = 0;

        for (const task of tasks) {
            try {
                const summary = task.type === 'milestone'
                    ? `[Milestone] ${task.name}`
                    : task.name;

                const description = [
                    `Status: ${task.status}`,
                    `Progress: ${task.progress}%`,
                    task.assignee ? `Assignee: ${task.assignee}` : null,
                    task.estimatedHours ? `Est. Hours: ${task.estimatedHours}` : null,
                    `\nSynced from ProBuild`,
                ].filter(Boolean).join('\n');

                const startDate = new Date(task.startDate).toISOString().split('T')[0];
                const endDate = new Date(task.endDate).toISOString().split('T')[0];

                // Search for existing event by ProBuild task ID in extendedProperties
                const existingEvents = await calendar.events.list({
                    calendarId: targetCalendarId,
                    privateExtendedProperty: `probuildTaskId=${task.id}`,
                    maxResults: 1,
                });

                const eventBody = {
                    summary,
                    description,
                    start: { date: startDate },
                    end: { date: endDate },
                    colorId: task.status === 'Complete' ? '10' : task.status === 'Blocked' ? '11' : '9',
                    extendedProperties: {
                        private: { probuildTaskId: task.id, probuildProjectId: projectId },
                    },
                };

                if (existingEvents.data.items && existingEvents.data.items.length > 0) {
                    await calendar.events.update({
                        calendarId: targetCalendarId,
                        eventId: existingEvents.data.items[0].id!,
                        requestBody: eventBody,
                    });
                } else {
                    await calendar.events.insert({
                        calendarId: targetCalendarId,
                        requestBody: eventBody,
                    });
                }
                synced++;
            } catch (e) {
                console.error(`Failed to sync task ${task.id}:`, e);
                errors++;
            }
        }

        return NextResponse.json({ synced, errors, calendarName, total: tasks.length });
    } catch (error) {
        console.error('Calendar sync error:', error);
        return NextResponse.json({ error: 'Failed to sync calendar' }, { status: 500 });
    }
}
