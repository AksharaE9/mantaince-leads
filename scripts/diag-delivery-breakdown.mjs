import { query, connectDB } from '../server/src/config/db.js';

async function main() {
    await connectDB();
    const res = await query(`SELECT errors FROM csv_upload_logs WHERE id = $1`, ['a7c9c72b-132d-4a20-a993-d45dbf292091']);
    const errors = res.rows[0].errors || [];
    console.log('Total rows:', errors.length);

    let dateErr = 0, deliveryDateErr = 0, employeeErr = 0, phoneErr = 0, businessNameErr = 0, otherErr = 0;
    const employeeNames = new Set();
    const phoneSamples = [];
    for (const e of errors) {
        const msg = e.errors || e.reason || '';
        if (/Date is not a valid date/.test(msg)) dateErr++;
        if (/Delivery Date is not a valid date/.test(msg)) deliveryDateErr++;
        if (/No matching employee/.test(msg)) employeeErr++;
        if (/[Pp]hone/.test(msg)) { phoneErr++; phoneSamples.push({row: e.row, msg, phone: e.originalRow?.['Phone Number']}); }
        if (/Business Name/.test(msg)) businessNameErr++;
        const known = ['Date is not a valid date', 'Delivery Date is not a valid date', 'No matching employee', 'new Business Type'];
        if (!known.some(k => msg.includes(k))) { otherErr++; }
        const name = e.originalRow?.['Employee Name'];
        if (name) employeeNames.add(name);
    }
    console.log({ dateErr, deliveryDateErr, employeeErr, phoneErr, businessNameErr, otherErr });
    console.log('Distinct employee names referenced:', [...employeeNames]);

    // Would phone number alone have blocked any row? Check all phone values validity per PHONE_REGEX logic
    const PHONE_REGEX = /^\+?\d{7,15}$/;
    let invalidPhones = 0;
    for (const e of errors) {
        const raw = e.originalRow?.['Phone Number'] || '';
        const cleaned = String(raw).trim().replace(/[^\d+]/g, '');
        if (!cleaned || !PHONE_REGEX.test(cleaned)) { invalidPhones++; console.log('INVALID PHONE row', e.row, JSON.stringify(raw)); }
    }
    console.log('Rows with genuinely invalid/missing phone:', invalidPhones, 'out of', errors.length);

    process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
