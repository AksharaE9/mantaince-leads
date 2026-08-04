// Live regression test for the phone-number-only-mandatory policy, run
// against the real DB in a disposable, uniquely-named test vertical
// (same isolated-test-vertical/cleanup pattern as v4-isolated-audit.js).
// Exercises the REAL processor/controller code paths directly (not HTTP),
// same technique CLAUDE.md documents for testing queued-job processors.
import crypto from 'crypto';
import { query, connectDB } from '../server/src/config/db.js';
import { processCsvJob } from '../server/src/jobs/csvProcessor.js';
import { processRawDataJob } from '../server/src/jobs/rawDataProcessor.js';
import { processDeliveryDataJob } from '../server/src/jobs/deliveryDataProcessor.js';

const results = [];
const check = (name, cond, detail) => {
    results.push({ name, pass: !!cond, detail });
    console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

function csvBufferFromRows(headers, rows) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.map(esc).join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))];
    return Buffer.from(lines.join('\n'), 'utf8').toString('base64');
}

async function main() {
    await connectDB();

    const testName = `__phone_only_test_${Date.now()}`;
    const verticalId = crypto.randomUUID();
    const subVerticalId = crypto.randomUUID();
    const adminRes = await query(`SELECT id FROM users WHERE email = 'admin@gmail.com' LIMIT 1`);
    const adminId = adminRes.rows[0]?.id;
    if (!adminId) throw new Error('admin@gmail.com not found — cannot attribute test records');

    await query(`INSERT INTO verticals (id, name, slug, created_by) VALUES ($1, $2, $3, $4)`,
        [verticalId, testName, testName.toLowerCase().replace(/_/g, '-'), adminId]);
    await query(`INSERT INTO sub_verticals (id, name, slug, vertical_id, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [subVerticalId, testName, testName.toLowerCase().replace(/_/g, '-'), verticalId, adminId]);

    try {
        // ── 1. COS bulk upload (csvProcessor.js): phone-only row (everything else blank) ──
        {
            const batchId = crypto.randomUUID();
            await query(`INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, entity_type) VALUES ($1,$2,$3,'lead')`, [batchId, adminId, verticalId]);
            const fileBufferBase64 = csvBufferFromRows(
                ['DATE', 'EMPLOYEE NAME', 'BUSINESS TYPE', 'BUSINESS / PERSON / SHOP / COMPANY NAME', 'CONTACT NUMBER'],
                [{ 'DATE': '', 'EMPLOYEE NAME': 'Totally Unknown Person', 'BUSINESS TYPE': '', 'BUSINESS / PERSON / SHOP / COMPANY NAME': '', 'CONTACT NUMBER': '9000000001' }]
            );
            await processCsvJob({ data: { batchId, fileBufferBase64, verticalId, uploadedBy: adminId, subVerticalId, leadType: 'CALL', fileExt: '.csv' }, progress: async () => {} });
            const log = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
            check('COS bulk: phone-only row inserts (success_count=1)', log.success_count === 1, `success=${log.success_count} failed=${log.failed_count}`);
            const inserted = (await query('SELECT * FROM cost_conversions WHERE csv_batch_id = $1', [batchId])).rows[0];
            check('COS bulk: blank name/business/date stored, no crash', !!inserted, inserted ? `name="${inserted.name}"` : 'no row');
        }

        // ── 2. COS bulk upload: missing phone still blocks ──
        {
            const batchId = crypto.randomUUID();
            await query(`INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, entity_type) VALUES ($1,$2,$3,'lead')`, [batchId, adminId, verticalId]);
            const fileBufferBase64 = csvBufferFromRows(
                ['BUSINESS / PERSON / SHOP / COMPANY NAME', 'CONTACT NUMBER'],
                [{ 'BUSINESS / PERSON / SHOP / COMPANY NAME': 'Has A Name', 'CONTACT NUMBER': '' }]
            );
            await processCsvJob({ data: { batchId, fileBufferBase64, verticalId, uploadedBy: adminId, subVerticalId, leadType: 'CALL', fileExt: '.csv' }, progress: async () => {} });
            const log = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
            check('COS bulk: missing phone still blocks the row', log.success_count === 0 && log.failed_count === 1, `success=${log.success_count} failed=${log.failed_count}`);
        }

        // ── 3. Raw Data bulk upload: phone-only + malformed date + unknown employee ──
        {
            const batchId = crypto.randomUUID();
            await query(`INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, entity_type) VALUES ($1,$2,$3,'raw_data')`, [batchId, adminId, verticalId]);
            const fileBufferBase64 = csvBufferFromRows(
                ['Date', 'Employee Name', 'Business Name', 'Phone Number'],
                [{ Date: '23-06-26', 'Employee Name': 'Ujwal', 'Business Name': '', 'Phone Number': '9000000002' }]
            );
            await processRawDataJob({ data: { batchId, fileBufferBase64, verticalId, uploadedBy: adminId, fileExt: '.csv' }, progress: async () => {} });
            const log = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
            check('Raw Data bulk: DD-MM-YY date + unknown employee + blank business name all insert successfully', log.success_count === 1, `success=${log.success_count} failed=${log.failed_count}`);
            const inserted = (await query('SELECT * FROM raw_data WHERE csv_batch_id = $1', [batchId])).rows[0];
            // Local getters, not .toISOString() — see CLAUDE.md's exceljs/date
            // timezone gotcha (this exact pitfall bit the app once already).
            const d = inserted && new Date(inserted.date);
            const localYmd = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;
            check('Raw Data: date parsed correctly (2026-06-23)', localYmd === '2026-06-23', localYmd);
            check('Raw Data: employee_name_raw preserved for audit', inserted?.employee_name_raw === 'Ujwal', `employee_name_raw="${inserted?.employee_name_raw}"`);
            check('Raw Data: assigned_user_id left null (unresolved, not guessed)', inserted?.assigned_user_id === null);
            const warningEntries = (log.errors || []).filter(e => e.warning);
            check('Raw Data: unresolved employee + blank business name recorded as warnings, not errors', warningEntries.some(w => w.field === 'employeeName'), JSON.stringify(warningEntries.map(w => w.field)));
        }

        // ── 4. Delivery Data bulk upload: reproduces the exact real-world failure shape ──
        {
            const batchId = crypto.randomUUID();
            await query(`INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, entity_type) VALUES ($1,$2,$3,'delivery_data')`, [batchId, adminId, verticalId]);
            const fileBufferBase64 = csvBufferFromRows(
                ['Date', 'Employee Name', 'Business Name', 'Phone Number', 'Delivery Date'],
                [
                    { Date: '23-06-26', 'Employee Name': 'Ujwal', 'Business Name': '', 'Phone Number': '9000000003', 'Delivery Date': '26-06-2026' },
                    { Date: '24-06-26', 'Employee Name': 'Ujwal R', 'Business Name': '', 'Phone Number': '9000000004', 'Delivery Date': '26-06-2026' },
                ]
            );
            await processDeliveryDataJob({ data: { batchId, fileBufferBase64, verticalId, uploadedBy: adminId, fileExt: '.csv' }, progress: async () => {} });
            const log = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
            check('Delivery Data bulk: reproduces & fixes the real 2-row failure shape (both now succeed)', log.success_count === 2 && log.failed_count === 0, `success=${log.success_count} failed=${log.failed_count}`);
        }

        // ── 5. Delivery Data bulk upload: genuinely invalid phone still blocks ──
        {
            const batchId = crypto.randomUUID();
            await query(`INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, entity_type) VALUES ($1,$2,$3,'delivery_data')`, [batchId, adminId, verticalId]);
            const fileBufferBase64 = csvBufferFromRows(
                ['Date', 'Phone Number'],
                [{ Date: '2026-06-23', 'Phone Number': 'abc' }]
            );
            await processDeliveryDataJob({ data: { batchId, fileBufferBase64, verticalId, uploadedBy: adminId, fileExt: '.csv' }, progress: async () => {} });
            const log = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
            check('Delivery Data bulk: invalid phone still blocks (phone remains the one real blocker)', log.success_count === 0 && log.failed_count === 1, `success=${log.success_count} failed=${log.failed_count}`);
        }

        // ── Summary ──
        const failed = results.filter(r => !r.pass);
        console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
        if (failed.length) {
            console.log('FAILURES:', failed.map(f => f.name));
        }
    } finally {
        // ── Cleanup: delete everything created under this disposable vertical ──
        await query('DELETE FROM cost_conversions WHERE vertical_id = $1', [verticalId]);
        await query('DELETE FROM raw_data WHERE vertical_id = $1', [verticalId]);
        await query('DELETE FROM delivery_data WHERE vertical_id = $1', [verticalId]);
        await query('DELETE FROM csv_upload_logs WHERE vertical_id = $1', [verticalId]);
        await query('DELETE FROM sub_verticals WHERE vertical_id = $1', [verticalId]);
        await query('DELETE FROM verticals WHERE id = $1', [verticalId]);
        console.log('\nCleanup complete — disposable test vertical fully removed.');
    }
    process.exit(results.some(r => !r.pass) ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
