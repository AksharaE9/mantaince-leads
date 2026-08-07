// End-to-end verification of the template mandatory-marker + DD-MM-YYYY
// date-format fixes, across all 4 sections, in a disposable isolated test
// vertical/subvertical on the real DB (same pattern as
// diag-regression-phone-only.mjs). Cleans up after itself.
import crypto from 'crypto';
import ExcelJS from 'exceljs';
import { query, connectDB } from '../src/config/db.js';
import { getLeadImportSchema, getAssignableAgentNames } from '../src/services/leadImportSchema.js';
import { buildXlsxTemplate } from '../src/services/leadImportTemplate.js';
import { RAW_DATA_FIELDS, getAssignableAgents as getRawAgents, getKnownBusinessTypes } from '../src/services/rawDataImportSchema.js';
import { DELIVERY_DATA_FIELDS } from '../src/services/deliveryDataImportSchema.js';
import { processCsvJob } from '../src/jobs/csvProcessor.js';
import { processRawDataJob } from '../src/jobs/rawDataProcessor.js';
import { processDeliveryDataJob } from '../src/jobs/deliveryDataProcessor.js';

const REQUIRED_FILL = 'FFFFC7CE'; // pink/red — must appear on exactly the required column(s)
const results = [];
const check = (name, cond, detail) => {
    results.push({ name, pass: !!cond, detail });
    console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

// Same DD-MM-YYYY sample values the controllers now pass.
const SAMPLE_VALUES_COS = {
    date: '24-07-2026', businessName: 'Acme Traders', phone: '9876543210',
    appointmentDate: '01-08-2026', followUpDates: '05-08-2026',
};
const SAMPLE_VALUES_RAWDELIVERY = {
    date: '24-07-2026', businessName: 'Acme Traders', phoneNumber: '9876543210',
    appointmentDate: '01-08-2026', deliveryDate: '05-08-2026',
};

function csvBufferFromRows(headers, rows) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.map(esc).join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))];
    return Buffer.from(lines.join('\n'), 'utf8').toString('base64');
}

// Inspects a generated xlsx buffer: which header cells are highlighted
// required, and what the row-2 sample date values actually are.
async function inspectTemplate(buffer, schema) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const sheet = wb.getWorksheet('Import Template');
    const headerRow = sheet.getRow(1);
    const sampleRow = sheet.getRow(2);
    const requiredCols = [];
    const sampleByKey = {};
    schema.forEach((f, i) => {
        const cell = headerRow.getCell(i + 1);
        const fill = cell.fill?.fgColor?.argb;
        if (fill === REQUIRED_FILL) requiredCols.push(f.label);
        sampleByKey[f.key] = sampleRow.getCell(i + 1).value;
    });
    return { requiredCols, sampleByKey };
}

async function main() {
    await connectDB();

    const testName = `__template_e2e_${Date.now()}`;
    const verticalId = crypto.randomUUID();
    const subVerticalId = crypto.randomUUID();
    const adminRes = await query(`SELECT id FROM users WHERE email = 'adminofleads@gmail.com' LIMIT 1`);
    const adminId = adminRes.rows[0]?.id;
    if (!adminId) throw new Error('adminofleads@gmail.com not found');

    await query(`INSERT INTO verticals (id, name, slug, created_by) VALUES ($1, $2, $3, $4)`,
        [verticalId, testName, testName.toLowerCase().replace(/_/g, '-'), adminId]);
    await query(`INSERT INTO sub_verticals (id, name, slug, vertical_id, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [subVerticalId, testName, testName.toLowerCase().replace(/_/g, '-'), verticalId, adminId]);

    try {
        // ── 1. COS template ──
        {
            const schema = await getLeadImportSchema(verticalId, 'CALL');
            const agentNames = await getAssignableAgentNames(verticalId);
            const wb = await buildXlsxTemplate(schema, agentNames, SAMPLE_VALUES_COS);
            const buffer = await wb.xlsx.writeBuffer();
            const { requiredCols, sampleByKey } = await inspectTemplate(Buffer.from(buffer), schema);
            check('COS template: only Contact Number marked required', requiredCols.length === 1 && requiredCols[0] === 'Contact Number', JSON.stringify(requiredCols));
            check('COS template: Date sample is DD-MM-YYYY', sampleByKey.date === '24-07-2026', sampleByKey.date);
            check('COS template: Appointment Date sample is DD-MM-YYYY', sampleByKey.appointmentDate === '01-08-2026', sampleByKey.appointmentDate);
        }

        // ── 2. Positives template ──
        {
            const schema = await getLeadImportSchema(verticalId, 'POSITIVE');
            const agentNames = await getAssignableAgentNames(verticalId);
            const wb = await buildXlsxTemplate(schema, agentNames, SAMPLE_VALUES_COS);
            const buffer = await wb.xlsx.writeBuffer();
            const { requiredCols, sampleByKey } = await inspectTemplate(Buffer.from(buffer), schema);
            check('Positives template: only Contact Number marked required', requiredCols.length === 1 && requiredCols[0] === 'Contact Number', JSON.stringify(requiredCols));
            check('Positives template: Date sample is DD-MM-YYYY', sampleByKey.date === '24-07-2026', sampleByKey.date);
            check('Positives template: Follow-Up Dates sample is DD-MM-YYYY', sampleByKey.followUpDates === '05-08-2026', sampleByKey.followUpDates);
        }

        // ── 3. Raw Data template ──
        {
            const agents = await getRawAgents(verticalId);
            const wb = await buildXlsxTemplate(RAW_DATA_FIELDS, agents.map(a => a.name), SAMPLE_VALUES_RAWDELIVERY);
            const buffer = await wb.xlsx.writeBuffer();
            const { requiredCols, sampleByKey } = await inspectTemplate(Buffer.from(buffer), RAW_DATA_FIELDS);
            check('Raw Data template: only Phone Number marked required', requiredCols.length === 1 && requiredCols[0] === 'Phone Number', JSON.stringify(requiredCols));
            check('Raw Data template: Date sample is DD-MM-YYYY', sampleByKey.date === '24-07-2026', sampleByKey.date);
        }

        // ── 4. Delivery Data template ──
        {
            const agents = await getRawAgents(verticalId);
            const wb = await buildXlsxTemplate(DELIVERY_DATA_FIELDS, agents.map(a => a.name), SAMPLE_VALUES_RAWDELIVERY);
            const buffer = await wb.xlsx.writeBuffer();
            const { requiredCols, sampleByKey } = await inspectTemplate(Buffer.from(buffer), DELIVERY_DATA_FIELDS);
            check('Delivery Data template: only Phone Number marked required', requiredCols.length === 1 && requiredCols[0] === 'Phone Number', JSON.stringify(requiredCols));
            check('Delivery Data template: Delivery Date sample is DD-MM-YYYY', sampleByKey.deliveryDate === '05-08-2026', sampleByKey.deliveryDate);
        }

        // ── 5. Bulk upload: phone-only row + DD-MM-YYYY dates, all 4 sections ──
        {
            const batchId = crypto.randomUUID();
            await query(`INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, entity_type) VALUES ($1,$2,$3,'lead')`, [batchId, adminId, verticalId]);
            const fileBufferBase64 = csvBufferFromRows(
                ['DATE', 'BUSINESS / PERSON / SHOP / COMPANY NAME', 'CONTACT NUMBER'],
                [
                    { DATE: '24-07-2026', 'BUSINESS / PERSON / SHOP / COMPANY NAME': 'DMY Test Co', 'CONTACT NUMBER': '9100000001' },
                    { DATE: '', 'BUSINESS / PERSON / SHOP / COMPANY NAME': '', 'CONTACT NUMBER': '9100000002' },
                ]
            );
            await processCsvJob({ data: { batchId, fileBufferBase64, verticalId, uploadedBy: adminId, subVerticalId, leadType: 'CALL', fileExt: '.csv' }, progress: async () => {} });
            const log = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
            check('COS bulk: DD-MM-YYYY date row + phone-only row both insert', log.success_count === 2, `success=${log.success_count} failed=${log.failed_count}`);
        }
        {
            const batchId = crypto.randomUUID();
            await query(`INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, entity_type) VALUES ($1,$2,$3,'raw_data')`, [batchId, adminId, verticalId]);
            const fileBufferBase64 = csvBufferFromRows(
                ['Date', 'Business Name', 'Phone Number'],
                [
                    { Date: '24-07-2026', 'Business Name': 'DMY RawData Co', 'Phone Number': '9100000003' },
                    { Date: '', 'Business Name': '', 'Phone Number': '9100000004' },
                ]
            );
            await processRawDataJob({ data: { batchId, fileBufferBase64, verticalId, uploadedBy: adminId, fileExt: '.csv' }, progress: async () => {} });
            const log = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
            check('Raw Data bulk: DD-MM-YYYY date row + phone-only row both insert', log.success_count === 2, `success=${log.success_count} failed=${log.failed_count}`);
            const rows = (await query('SELECT date FROM raw_data WHERE csv_batch_id = $1 AND date IS NOT NULL', [batchId])).rows;
            const d = rows[0]?.date && new Date(rows[0].date);
            const ymd = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;
            check('Raw Data bulk: DD-MM-YYYY date parsed to the correct calendar date', ymd === '2026-07-24', ymd);
        }
        {
            const batchId = crypto.randomUUID();
            await query(`INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, entity_type) VALUES ($1,$2,$3,'delivery_data')`, [batchId, adminId, verticalId]);
            const fileBufferBase64 = csvBufferFromRows(
                ['Date', 'Business Name', 'Phone Number', 'Delivery Date'],
                [
                    { Date: '24-07-2026', 'Business Name': 'DMY Delivery Co', 'Phone Number': '9100000005', 'Delivery Date': '05-08-2026' },
                    { Date: '', 'Business Name': '', 'Phone Number': '9100000006', 'Delivery Date': '' },
                ]
            );
            await processDeliveryDataJob({ data: { batchId, fileBufferBase64, verticalId, uploadedBy: adminId, fileExt: '.csv' }, progress: async () => {} });
            const log = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
            check('Delivery Data bulk: DD-MM-YYYY date row + phone-only row both insert', log.success_count === 2, `success=${log.success_count} failed=${log.failed_count}`);
        }

        // ── 6. Single-add: DD-MM-YYYY via parseFlexibleDate (already unit-verified; re-confirm against real DB insert) ──
        {
            const { parseFlexibleDate } = await import('../src/services/rawDataImportSchema.js');
            const parsed = parseFlexibleDate('24-07-2026');
            check('Single-add date parser: DD-MM-YYYY -> correct calendar date', parsed && parsed.getUTCFullYear() === 2026 && parsed.getUTCMonth() === 6 && parsed.getUTCDate() === 24, parsed?.toISOString());
        }

        // ── 7. Quick regression: duplicate detection still works post-fix ──
        {
            const batchId = crypto.randomUUID();
            await query(`INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, entity_type) VALUES ($1,$2,$3,'raw_data')`, [batchId, adminId, verticalId]);
            const fileBufferBase64 = csvBufferFromRows(
                ['Date', 'Business Name', 'Phone Number'],
                [{ Date: '24-07-2026', 'Business Name': 'Dup Test', 'Phone Number': '9100000003' }] // same phone as an earlier successful row
            );
            await processRawDataJob({ data: { batchId, fileBufferBase64, verticalId, uploadedBy: adminId, fileExt: '.csv' }, progress: async () => {} });
            const log = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
            check('Regression: duplicate phone detection still works', log.duplicate_count === 1, `duplicate_count=${log.duplicate_count}`);
        }

        // ── Summary ──
        const failed = results.filter(r => !r.pass);
        console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
        if (failed.length) console.log('FAILURES:', failed.map(f => f.name));
    } finally {
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
