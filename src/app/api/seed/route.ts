import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    if (process.env.NODE_ENV !== 'development') {
        return new Response(null, { status: 404 });
    }

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
        const project2 = await prisma.project.create({
            data: {
                name: 'Parkin Laundry Room',
                clientId: client4.id,
                location: 'Vancouver, Washington',
                status: 'Open',
                type: 'Laundry Room',
                code: '#1003'
            }
        });

        const project3 = await prisma.project.create({
            data: {
                name: 'Howard/Salzer Bathroom',
                clientId: client5.id,
                location: 'Vancouver, Washington',
                status: 'In Progress',
                type: 'Bathroom Remodeling',
                code: '#1004'
            }
        });

        const project4 = await prisma.project.create({
            data: {
                name: 'Anspach Bedroom',
                clientId: client6.id,
                location: 'Vancouver, Washington',
                status: 'Done',
                type: 'Bedroom Remodel',
                code: '#1005'
            }
        });

        const project5 = await prisma.project.create({
            data: {
                name: 'Atherton Kitchen',
                clientId: client7.id,
                location: 'Vancouver, Washington',
                status: 'Paid, Ready to Start',
                type: 'Kitchen Remodel',
                code: '#1006'
            }
        });

        const project6 = await prisma.project.create({
            data: {
                name: 'OHaver Garage Conversion',
                clientId: client8.id,
                location: 'Portland, Oregon',
                status: 'Open',
                type: 'Garage Conversion',
                code: '#1007'
            }
        });

        // --- Leads ---
        // Original leads
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

        // Leads tied to new projects
        const lead3 = await prisma.lead.create({
            data: {
                name: 'Ruth Parkin - Laundry Room Renovation',
                clientId: client4.id,
                stage: 'Won',
                source: 'Referral',
                location: 'Vancouver, WA',
                projectType: 'Laundry Room'
            }
        });

        const lead4 = await prisma.lead.create({
            data: {
                name: 'David Howard - Master Bath Remodel',
                clientId: client5.id,
                stage: 'Won',
                source: 'Houzz',
                location: 'Vancouver, WA',
                projectType: 'Bathroom Remodeling'
            }
        });

        const lead5 = await prisma.lead.create({
            data: {
                name: 'Karen Anspach - Bedroom Suite',
                clientId: client6.id,
                stage: 'Won',
                source: 'Google',
                location: 'Vancouver, WA',
                projectType: 'Bedroom Remodel'
            }
        });

        const lead6 = await prisma.lead.create({
            data: {
                name: 'Tricia Atherton - Kitchen Redesign',
                clientId: client7.id,
                stage: 'Won',
                source: 'Referral',
                location: 'Vancouver, WA',
                projectType: 'Kitchen Remodel'
            }
        });

        const lead7 = await prisma.lead.create({
            data: {
                name: 'Dan OHaver - Garage ADU Conversion',
                clientId: client8.id,
                stage: 'Won',
                source: 'My website',
                location: 'Portland, OR',
                projectType: 'Garage Conversion'
            }
        });

        // --- Estimates ---
        // Original estimates
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

        // Estimates tied to new projects
        await prisma.estimate.create({
            data: {
                title: 'Laundry Room Full Renovation',
                projectId: project2.id,
                leadId: lead3.id,
                code: 'EST-103',
                status: 'Approved',
                totalAmount: 18500,
                balanceDue: 18500
            }
        });

        await prisma.estimate.create({
            data: {
                title: 'Master Bathroom Remodel',
                projectId: project3.id,
                leadId: lead4.id,
                code: 'EST-104',
                status: 'Approved',
                totalAmount: 32000,
                balanceDue: 16000
            }
        });

        await prisma.estimate.create({
            data: {
                title: 'Bedroom Suite Renovation',
                projectId: project4.id,
                leadId: lead5.id,
                code: 'EST-105',
                status: 'Invoiced',
                totalAmount: 22000,
                balanceDue: 0
            }
        });

        await prisma.estimate.create({
            data: {
                title: 'Kitchen Full Redesign',
                projectId: project5.id,
                leadId: lead6.id,
                code: 'EST-106',
                status: 'Approved',
                totalAmount: 55000,
                balanceDue: 55000
            }
        });

        await prisma.estimate.create({
            data: {
                title: 'Garage to ADU Conversion',
                projectId: project6.id,
                leadId: lead7.id,
                code: 'EST-107',
                status: 'Sent',
                totalAmount: 75000,
                balanceDue: 75000
            }
        });

        return NextResponse.json({ success: true, message: "Database seeded successfully!" });
    } catch (error) {
        console.error(error);
        return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
    }
}
