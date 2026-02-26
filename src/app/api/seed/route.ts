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
