// One-off diagnostic: inspect the most recent failed Delivery Data bulk
// upload batch (or batches matching "Ujwal" employee-match errors) to get
// real evidence of what the raw Date/Delivery Date/Employee Name cells
// actually contained. Read-only — no writes.
import { query, connectDB } from '../server/src/config/db.js';

async function main() {
    await connectDB();

    const batches = await query(`
        SELECT id, entity_type, status, total_rows, success_count, failed_count, created_at
        FROM csv_upload_logs
        WHERE entity_type = 'delivery_data'
        ORDER BY created_at DESC
        LIMIT 10
    `);
    console.log('=== Recent delivery_data batches ===');
    console.table(batches.rows.map(r => ({ ...r, created_at: r.created_at?.toISOString?.() || r.created_at })));

    // Find the batch matching the 55-row/Ujwal failure signature
    let target = batches.rows.find(r => r.failed_count === 55 && r.total_rows === 55);
    if (!target) target = batches.rows.find(r => r.failed_count > 0);
    if (!target) {
        console.log('\nNo failed delivery_data batch found at all.');
        process.exit(0);
    }

    console.log('\n=== Target batch ===', target.id, target.created_at);

    const res = await query(`SELECT errors FROM csv_upload_logs WHERE id = $1`, [target.id]);
    const errors = res.rows[0].errors || [];
    console.log('Total error entries:', errors.length);

    // Aggregate error message patterns
    const msgCounts = {};
    for (const e of errors) {
        const msgs = (e.errors || e.reason ? [e.reason].filter(Boolean) : []);
        const list = Array.isArray(e.errors) ? e.errors.map(x => x.message || x) : msgs;
        for (const m of list) {
            const key = String(m).replace(/"[^"]*"/, '"X"');
            msgCounts[key] = (msgCounts[key] || 0) + 1;
        }
    }
    console.log('\n=== Error message frequency ===');
    console.table(Object.entries(msgCounts).map(([message, count]) => ({ message, count })));

    console.log('\n=== First 8 raw failed rows (originalRow) ===');
    for (const e of errors.slice(0, 8)) {
        console.log('--- row', e.row, '---');
        console.log('Date:', JSON.stringify(e.originalRow?.Date ?? e.originalRow?.date));
        console.log('Delivery Date:', JSON.stringify(e.originalRow?.['Delivery Date'] ?? e.originalRow?.deliveryDate));
        console.log('Employee Name:', JSON.stringify(e.originalRow?.['Employee Name'] ?? e.originalRow?.employeeName));
        console.log('Phone Number:', JSON.stringify(e.originalRow?.['Phone Number'] ?? e.originalRow?.phoneNumber));
        console.log('errors:', JSON.stringify(e.errors || e.reason));
    }

    // Check if "Ujwal" (or similar) exists as a real user
    console.log('\n=== Users matching "ujwal" (case-insensitive substring) ===');
    const users = await query(`SELECT id, name, is_active, is_approved, vertical_access FROM users WHERE name ILIKE $1`, ['%ujwal%']);
    console.table(users.rows);

    console.log('\n=== All active/approved users (name only, first 40) ===');
    const allUsers = await query(`SELECT name, is_active, is_approved FROM users ORDER BY name LIMIT 40`);
    console.table(allUsers.rows);

    process.exit(0);
}
main().catch(e => { console.error('ERROR', e); process.exit(1); });
