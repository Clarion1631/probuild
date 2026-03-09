import Database from 'better-sqlite3';

const db = new Database('dev.db');

async function main() {
    db.prepare('DELETE FROM Estimate').run();
    db.prepare('DELETE FROM Project').run();
    db.prepare('DELETE FROM Lead').run();
    db.prepare('DELETE FROM Client').run();

    const insertClient = db.prepare('INSERT INTO Client (id, name, initials, email) VALUES (?, ?, ?, ?)');
    const client1Id = 'c1';
    insertClient.run(client1Id, 'Dustin Smith', 'DS', 'dustin@example.com');

    const client2Id = 'c2';
    insertClient.run(client2Id, 'Jayme Fisher', 'JF', 'jayme@example.com');

    const client3Id = 'c3';
    insertClient.run(client3Id, 'Janice Adkins', 'JA', 'janice@example.com');

    const insertLead = db.prepare('INSERT INTO Lead (id, name, clientId, stage, source, location, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const lead1Id = 'l1';
    insertLead.run(lead1Id, 'Dustin Smith sent a Direct Message', client1Id, 'New', 'My website', 'Portland, OR', Date.now());

    const lead2Id = 'l2';
    insertLead.run(lead2Id, 'Jennifer Obrien inquiry', client3Id, 'Estimate Sent', 'Houzz', 'Seattle, WA', Date.now());

    const insertProject = db.prepare('INSERT INTO Project (id, name, clientId, location, status, type, code, viewedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const project1Id = 'p1';
    insertProject.run(project1Id, 'Fisher water damage', client2Id, 'Vancouver, Washington', 'Closed', 'Water Damage Restoration', '#1001', Date.now(), Date.now());

    const project2Id = 'p2';
    insertProject.run(project2Id, 'Adkins Kitchen', client3Id, 'Castle Rock, Washington', 'In Progress', 'Kitchen Remodel', '#1002', Date.now(), Date.now());

    const insertEstimate = db.prepare('INSERT INTO Estimate (id, title, projectId, leadId, code, status, totalAmount, balanceDue, privacy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insertEstimate.run('e1', 'Kitchen Remodel Initial Estimate', null, lead1Id, 'EST-101', 'Sent', 45000, 45000, 'Shared', Date.now());
    insertEstimate.run('e2', 'Water Damage Repairs', project1Id, null, 'EST-102', 'Invoiced', 12500, 0, 'Shared', Date.now());

    console.log("Database seeded successfully via better-sqlite3!");
}

main().catch(console.error);
