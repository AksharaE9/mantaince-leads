// Re-run the original failed 55-row Delivery Data batch's raw rows through
// the ACTUAL, now-fixed validateDeliveryDataRow() — not a re-derivation from
// the old error log, but a real execution of the current code, using the
// real agent list for the vertical this batch belongs to.
import { query, connectDB } from '../server/src/config/db.js';
import { validateDeliveryDataRow } from '../server/src/services/deliveryDataImportSchema.js';
import { getAssignableAgents, getKnownBusinessTypes } from '../server/src/services/rawDataImportSchema.js';

const BATCH_ID = 'a7c9c72b-132d-4a20-a993-d45dbf292091';

// normalizeRowKeys/toSchemaKeyedRow mirror deliveryDataProcessor.js exactly
function normalizeRowKeys(rawRow) {
    const row = {};
    for (const k of Object.keys(rawRow)) {
        const key = k.toLowerCase().trim().replace(/\r?\n/g, ' ').replace(/\s+/g, ' ');
        if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') row[key] = rawRow[k];
    }
    return row;
}
const HEADER_KEY_MAP = {
    date: 'date', 'employee name': 'employeeName', 'business type': 'businessType',
    'business name': 'businessName', area: 'area', city: 'city', 'phone number': 'phoneNumber',
    address: 'address', adress: 'address', 'appointment date': 'appointmentDate',
    'appointment timings': 'appointmentTimings', remarks: 'remarks',
    'delivery date': 'deliveryDate', 'delivery time': 'deliveryTime',
};
function toSchemaKeyedRow(n) {
    const row = {};
    for (const [h, k] of Object.entries(HEADER_KEY_MAP)) if (n[h] !== undefined) row[k] = n[h];
    return row;
}

async function main() {
    await connectDB();

    const batchRes = await query(`SELECT vertical_id, errors FROM csv_upload_logs WHERE id = $1`, [BATCH_ID]);
    const { vertical_id: verticalId, errors: allEntries } = batchRes.rows[0];
    const rowEntries = (allEntries || []).filter(e => !e.warning && e.originalRow);

    console.log(`Original batch: ${rowEntries.length} failed rows, vertical ${verticalId}`);

    const [agents, knownBusinessTypes] = await Promise.all([
        getAssignableAgents(verticalId),
        getKnownBusinessTypes(verticalId),
    ]);
    console.log(`Real assignable agents for this vertical: ${agents.length}`);

    const PHONE_REGEX = /^\+?\d{7,15}$/;
    let pass = 0, blockedByPhone = 0;
    const dateWarnings = new Set(), employeeWarnings = new Set();
    const blockedRows = [];

    for (const entry of rowEntries) {
        const row = toSchemaKeyedRow(normalizeRowKeys(entry.originalRow));
        const { errors, warnings } = validateDeliveryDataRow(row, { agents, knownBusinessTypes });

        if (errors.length > 0) {
            blockedByPhone++;
            blockedRows.push({ row: entry.row, errors: errors.map(e => e.message) });
        } else {
            pass++;
        }
        for (const w of warnings) {
            if (w.field === 'date' || w.field === 'deliveryDate') dateWarnings.add(entry.row);
            if (w.field === 'employeeName') employeeWarnings.add(entry.row);
        }
    }

    console.log('\n=== RESULT: re-running the real 55 failed rows through the FIXED validateDeliveryDataRow() ===');
    console.log({
        totalRows: rowEntries.length,
        nowPass: pass,
        stillBlocked: blockedByPhone,
        rowsWithDateWarningButPassed: dateWarnings.size,
        rowsWithEmployeeWarningButPassed: employeeWarnings.size,
    });
    if (blockedRows.length) {
        console.log('\nStill-blocked rows (should only be genuinely invalid/missing phone):');
        for (const b of blockedRows) console.log(' row', b.row, b.errors);
    }

    process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
