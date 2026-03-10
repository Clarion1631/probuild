import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    try {
        // Clear existing
        await prisma.estimate.deleteMany({})
        await prisma.project.deleteMany({})
        await prisma.lead.deleteMany({})
        await prisma.client.deleteMany({})

        const client1 = await prisma.client.create({
            data: {
                name: 'Dustin Smith',
                initials: 'DS',
                email: 'dustin@example.com'
            }
        });

        const client2 = await prisma.client.create({
            data: {
                name: 'Jayme Fisher',
                initials: 'JF',
                email: 'jayme@example.com'
            }
        });

        const client3 = await prisma.client.create({
            data: {
                name: 'Janice Adkins',
                initials: 'JA',
                email: 'janice@example.com'
            }
        });

        // Create leads
        const lead1 = await prisma.lead.create({
            data: {
                name: 'Dustin Smith sent a Direct Message',
                clientId: client1.id,
                stage: 'New',
                source: 'My website',
                location: 'Portland, OR',
                projectType: 'Kitchen Remodel'
            }
        });

        await prisma.lead.create({
            data: {
                name: 'Jennifer Obrien inquiry',
                clientId: client3.id,
                stage: 'Estimate Sent',
                source: 'Houzz',
                location: 'Seattle, WA',
                projectType: 'Bathroom Remodel'
            }
        });

        // Create projects
        const project1 = await prisma.project.create({
            data: {
                name: 'Fisher water damage',
                clientId: client2.id,
                location: 'Vancouver, Washington',
                status: 'Closed',
                type: 'Water Damage Restoration',
                code: '#1001'
            }
        });

        await prisma.project.create({
            data: {
                name: 'Adkins Kitchen',
                clientId: client3.id,
                location: 'Castle Rock, Washington',
                status: 'In Progress',
                type: 'Kitchen Remodel',
                code: '#1002'
            }
        });

        // Additional clients for seeded projects
        const client4 = await prisma.client.create({
            data: { name: 'Ruth Parkin', initials: 'RP', email: 'ruth@example.com' }
        });
        const client5 = await prisma.client.create({
            data: { name: 'David Howard', initials: 'DH', email: 'david.howard@example.com' }
        });
        const client6 = await prisma.client.create({
            data: { name: 'Karen Anspach', initials: 'KA', email: 'karen.a@example.com' }
        });
        const client7 = await prisma.client.create({
            data: { name: 'Tricia Atherton', initials: 'TA', email: 'tricia@example.com' }
        });
        const client8 = await prisma.client.create({
            data: { name: 'Dan OHaver', initials: 'DO', email: 'dan.ohaver@example.com' }
        });

        // 5 additional projects in various statuses
        await prisma.project.create({
            data: {
                name: 'Parkin Laundry Room',
                clientId: client4.id,
                location: 'Vancouver, Washington',
                status: 'Open',
                type: 'Laundry Room',
                code: '#1003'
            }
        });

        await prisma.project.create({
            data: {
                name: 'Howard/Salzer Bathroom',
                clientId: client5.id,
                location: 'Vancouver, Washington',
                status: 'In Progress',
                type: 'Bathroom Remodeling',
                code: '#1004'
            }
        });

        await prisma.project.create({
            data: {
                name: 'Anspach Bedroom',
                clientId: client6.id,
                location: 'Vancouver, Washington',
                status: 'Done',
                type: 'Bedroom Remodel',
                code: '#1005'
            }
        });

        await prisma.project.create({
            data: {
                name: 'Atherton Kitchen',
                clientId: client7.id,
                location: 'Vancouver, Washington',
                status: 'Paid, Ready to Start',
                type: 'Kitchen Remodel',
                code: '#1006'
            }
        });

        await prisma.project.create({
            data: {
                name: 'OHaver Garage Conversion',
                clientId: client8.id,
                location: 'Portland, Oregon',
                status: 'Open',
                type: 'Garage Conversion',
                code: '#1007'
            }
        });

        // Create Estimate connected to Lead
        await prisma.estimate.create({
            data: {
                title: 'Kitchen Remodel Initial Estimate',
                leadId: lead1.id,
                code: 'EST-101',
                status: 'Sent',
                totalAmount: 45000,
                balanceDue: 45000
            }
        });

        // Create Estimate connected to Project
        await prisma.estimate.create({
            data: {
                title: 'Water Damage Repairs',
                projectId: project1.id,
                code: 'EST-102',
                status: 'Invoiced',
                totalAmount: 12500,
                balanceDue: 0
            }
        });

        return NextResponse.json({ success: true, message: "Database seeded successfully!" });
    } catch (error) {
        console.error(error);
        return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
    }
}
