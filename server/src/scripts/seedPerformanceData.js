import { connectDB, query } from '../config/db.js';
import crypto from 'crypto';

const LEAD_NAMES = [
    'Aarav Patel', 'Vihaan Sharma', 'Aditya Verma', 'Sai Reddy', 'Ananya Iyer',
    'John Doe', 'Jane Smith', 'Michael Johnson', 'Emily Davis', 'Daniel Brown',
    'Robert Miller', 'James Wilson', 'Mary Moore', 'Patricia Taylor', 'David Anderson',
    'Elizabeth Thomas', 'William Jackson', 'Linda White', 'Joseph Harris', 'Susan Martin'
];

const LEAD_AREAS = [
    'Whitefield Bangalore', 'Gachibowli Hyderabad', 'Andheri Mumbai', 'DLF Phase 3 Gurgaon',
    'Downtown Austin', 'Manhattan NYC', 'Beverly Hills LA', 'Soho London', 'Capitol Hill Denver'
];

const STATUSES = ['new', 'contacted', 'qualified', 'visit_scheduled', 'visit_completed', 'negotiation', 'converted', 'lost', 'invalid'];
const LEAD_TYPES = ['CALL', 'POSITIVE'];

async function seed() {
    await connectDB();
    console.log('🌱 Seeding performance data...');

    // 1. Get admin user
    const adminRes = await query("SELECT id FROM users WHERE email = 'adminofleads@gmail.com'");
    const adminId = adminRes.rows[0]?.id;
    if (!adminId) {
        console.error("❌ Admin user not found");
        process.exit(1);
    }

    // 2. Fetch all verticals and their sub-verticals
    const vertsRes = await query("SELECT id, name, slug FROM verticals");
    if (vertsRes.rows.length === 0) {
        console.error("❌ No verticals found");
        process.exit(1);
    }

    const subVertsMap = {};
    for (const v of vertsRes.rows) {
        const subsRes = await query("SELECT id FROM sub_verticals WHERE vertical_id = $1", [v.id]);
        subVertsMap[v.id] = subsRes.rows.map(r => r.id);
    }

    // 3. Insert 1200 leads in batches
    console.log('Inserting 1200 leads...');
    let values = [];
    let queryText = `
        INSERT INTO cost_conversions (
            id, vertical_id, sub_vertical_id, assigned_to, uploaded_by,
            name, phone, business_name, data, status, lead_type, created_at, updated_at
        ) VALUES 
    `;

    const batchSize = 200;
    let count = 0;

    for (let i = 0; i < 1200; i++) {
        const id = crypto.randomUUID();
        const v = vertsRes.rows[i % vertsRes.rows.length];
        const subs = subVertsMap[v.id] || [];
        const subId = subs.length > 0 ? subs[Math.floor(Math.random() * subs.length)] : null;
        const name = `${LEAD_NAMES[i % LEAD_NAMES.length]} ${i}`;
        const phone = `+91998877${String(1000 + i)}`;
        const businessName = `Business Entity ${i}`;
        const status = STATUSES[i % STATUSES.length];
        const leadType = LEAD_TYPES[i % LEAD_TYPES.length];
        const area = LEAD_AREAS[i % LEAD_AREAS.length];
        const data = JSON.stringify({ area, score: Math.floor(Math.random() * 100), comments: 'Performance check' });
        
        // Random date in last 90 days
        const daysAgo = Math.floor(Math.random() * 90);
        const createdAt = new Date();
        createdAt.setDate(createdAt.getDate() - daysAgo);

        values.push(id, v.id, subId, adminId, adminId, name, phone, businessName, data, status, leadType, createdAt, createdAt);
        
        const baseIdx = (i % batchSize) * 13;
        queryText += `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5}, $${baseIdx + 6}, $${baseIdx + 7}, $${baseIdx + 8}, $${baseIdx + 9}, $${baseIdx + 10}, $${baseIdx + 11}, $${baseIdx + 12}, $${baseIdx + 13}),`;

        if ((i + 1) % batchSize === 0) {
            queryText = queryText.slice(0, -1); // remove trailing comma
            await query(queryText, values);
            count += batchSize;
            // reset
            values = [];
            queryText = `
                INSERT INTO cost_conversions (
                    id, vertical_id, sub_vertical_id, assigned_to, uploaded_by,
                    name, phone, business_name, data, status, lead_type, created_at, updated_at
                ) VALUES 
            `;
        }
    }

    console.log(`✅ Seeded ${count} performance leads.`);
    process.exit(0);
}

seed().catch(err => {
    console.error(err);
    process.exit(1);
});
