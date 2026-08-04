import { describe, it, expect } from 'vitest';
import { RAW_DATA_FIELDS, validateRawDataRow, resolveEmployeeName } from '../../../../server/src/services/rawDataImportSchema.js';

const AGENTS = [
    { id: 'u1', name: 'Rajesh Kumar' },
    { id: 'u2', name: 'Rajesh Krishnan' },
    { id: 'u3', name: 'Priya Sharma' },
];

describe('RAW_DATA_FIELDS', () => {
    it('has all 11 template fields in the exact source order', () => {
        expect(RAW_DATA_FIELDS.map(f => f.key)).toEqual([
            'date', 'employeeName', 'businessType', 'businessName', 'area', 'city',
            'phoneNumber', 'address', 'appointmentDate', 'appointmentTimings', 'remarks',
        ]);
    });

    it('corrects the source file\'s "Adress" typo and trims "Area "', () => {
        const address = RAW_DATA_FIELDS.find(f => f.key === 'address');
        const area = RAW_DATA_FIELDS.find(f => f.key === 'area');
        expect(address.label).toBe('Address');
        expect(area.label).toBe('Area');
    });

    it('never includes a vertical/businessVertical column — it is auto-assigned from context', () => {
        expect(RAW_DATA_FIELDS.some(f => /vertical/i.test(f.key) || /vertical/i.test(f.label))).toBe(false);
    });

    // Phone-number-only-mandatory policy (see CLAUDE.md / MissingFieldDataDiagnosis
    // follow-up on the 55-row Delivery Data upload failure): phoneNumber is the
    // only required field left in this schema.
    it('marks only phoneNumber as required — every other field is optional', () => {
        const required = RAW_DATA_FIELDS.filter(f => f.required).map(f => f.key);
        expect(required).toEqual(['phoneNumber']);
    });
});

// resolveEmployeeName is re-exported from server/src/utils/employeeMatch.js —
// phone-number-only-mandatory policy: it NEVER hard-rejects anymore. It always
// returns { userId, rawName, warning? }; an unresolved/ambiguous/blank name
// comes back as userId: null + an explanatory warning, never an error.
describe('resolveEmployeeName', () => {
    it('resolves an exact match, no warning', () => {
        const result = resolveEmployeeName('Priya Sharma', AGENTS);
        expect(result.userId).toBe('u3');
        expect(result.rawName).toBe('Priya Sharma');
        expect(result.warning).toBeUndefined();
    });

    it('is case-insensitive, no warning', () => {
        const result = resolveEmployeeName('priya sharma', AGENTS);
        expect(result.userId).toBe('u3');
        expect(result.warning).toBeUndefined();
    });

    it('leaves an ambiguous partial name (matching two employees) unresolved with a warning listing both, never blocks', () => {
        const result = resolveEmployeeName('Rajesh', AGENTS);
        expect(result.userId).toBeNull();
        expect(result.rawName).toBe('Rajesh');
        expect(result.warning).toBeTruthy();
        expect(result.warning).toContain('Rajesh Kumar');
        expect(result.warning).toContain('Rajesh Krishnan');
    });

    it('never silently picks one of two ambiguous matches', () => {
        const result = resolveEmployeeName('Rajesh K', AGENTS);
        expect(result.userId).toBeNull();
        expect(result.warning).toBeTruthy();
    });

    it('suggests closest matches for a typo with no match', () => {
        const result = resolveEmployeeName('Priya Sharm', AGENTS);
        // "Priya Sharm" is a substring-contained-in match of "Priya Sharma" — resolves,
        // but with a "please verify" warning since it wasn't an exact match.
        expect(result.userId).toBe('u3');
        expect(result.warning).toBeTruthy();
    });

    it('leaves unresolved (never blocks) a name that resembles nobody closely, with a warning + rawName preserved for audit', () => {
        const result = resolveEmployeeName('Zzxq Nomatch', AGENTS);
        expect(result.userId).toBeNull();
        expect(result.rawName).toBe('Zzxq Nomatch');
        expect(result.warning).toContain('No matching employee found');
    });

    it('returns null userId and no warning for an empty name — employee is optional', () => {
        const emptyResult = resolveEmployeeName('', AGENTS);
        expect(emptyResult.userId).toBeNull();
        expect(emptyResult.rawName).toBe('');
        expect(emptyResult.warning).toBeUndefined();

        const blankResult = resolveEmployeeName('   ', AGENTS);
        expect(blankResult.userId).toBeNull();
        expect(blankResult.warning).toBeUndefined();
    });
});

describe('validateRawDataRow', () => {
    const baseRow = {
        date: '2026-07-24',
        employeeName: 'Priya Sharma',
        businessType: 'Retail',
        businessName: 'Acme Traders',
        area: 'Whitefield',
        city: 'Bengaluru',
        phoneNumber: '9876543210',
        address: '123 Main Street',
        appointmentDate: '2026-08-01',
        appointmentTimings: '11:00 AM',
        remarks: 'Interested',
    };
    const ctx = { agents: AGENTS, knownBusinessTypes: new Set(['retail', 'wholesale']) };

    it('accepts a fully valid row with no errors or warnings', () => {
        const { errors, warnings, assignedUserId } = validateRawDataRow(baseRow, ctx);
        expect(errors).toEqual([]);
        expect(warnings).toEqual([]);
        expect(assignedUserId).toBe('u3');
    });

    // Phone-number-only-mandatory policy: a blank Date/Business Name is no
    // longer an error — only a blank/invalid Phone Number is.
    it('requires only Phone Number — blank Date and Business Name are accepted with no error', () => {
        const { errors } = validateRawDataRow({ ...baseRow, date: '', businessName: '', phoneNumber: '' }, ctx);
        const fields = errors.map(e => e.field);
        expect(fields).toEqual(['phoneNumber']);
    });

    it('does not require Area, City, Address, Appointment Date/Timings, Remarks, or Business Type', () => {
        const { errors } = validateRawDataRow({
            ...baseRow, area: '', city: '', address: '', appointmentDate: '', appointmentTimings: '', remarks: '', businessType: '',
        }, ctx);
        expect(errors).toEqual([]);
    });

    it('rejects an invalid phone number (the one thing that still blocks a row)', () => {
        const { errors } = validateRawDataRow({ ...baseRow, phoneNumber: 'not-a-phone' }, ctx);
        expect(errors).toContainEqual({ field: 'phoneNumber', message: 'Phone Number is not a valid phone number' });
    });

    // Phone-number-only-mandatory policy (Step 3): a present-but-unparseable
    // date is now a warning, not a hard reject — the row still inserts with
    // that field left blank.
    it('warns (does not reject) on an unparseable date', () => {
        const { errors, warnings } = validateRawDataRow({ ...baseRow, date: 'not-a-date' }, ctx);
        expect(errors.some(e => e.field === 'date')).toBe(false);
        expect(warnings.some(w => w.field === 'date')).toBe(true);
    });

    it('parses DD-MM-YYYY and DD-MM-YY dash-separated dates with no warning (the exact format that broke the real 55-row upload)', () => {
        const { warnings: w1 } = validateRawDataRow({ ...baseRow, date: '23-06-26' }, ctx);
        expect(w1.some(w => w.field === 'date')).toBe(false);

        const { warnings: w2 } = validateRawDataRow({ ...baseRow, date: '26-06-2026' }, ctx);
        expect(w2.some(w => w.field === 'date')).toBe(false);
    });

    // Step 2: an employee name that cannot be resolved is a warning, never a
    // hard block — the row still inserts, unassigned, with the raw text kept.
    it('warns (does not reject) on an employee name that cannot be resolved, and preserves the raw text', () => {
        const { errors, warnings, assignedUserId, employeeNameRaw } = validateRawDataRow({ ...baseRow, employeeName: 'Nobody Here' }, ctx);
        expect(errors.some(e => e.field === 'employeeName')).toBe(false);
        expect(warnings.some(w => w.field === 'employeeName')).toBe(true);
        expect(assignedUserId).toBeNull();
        expect(employeeNameRaw).toBe('Nobody Here');
    });

    it('flags (does not reject) a new Business Type not seen before', () => {
        const { errors, warnings } = validateRawDataRow({ ...baseRow, businessType: 'Pharmacy Chain' }, ctx);
        expect(errors).toEqual([]);
        expect(warnings).toContainEqual({
            field: 'businessType',
            message: '"Pharmacy Chain" is a new Business Type not seen before — accepted, flagged for review',
        });
    });

    it('does not flag a Business Type already seen (case-insensitively)', () => {
        const { warnings } = validateRawDataRow({ ...baseRow, businessType: 'RETAIL' }, ctx);
        expect(warnings).toEqual([]);
    });

    it('warns (does not reject) when Appointment Date is before Date', () => {
        const { errors, warnings } = validateRawDataRow({ ...baseRow, date: '2026-08-01', appointmentDate: '2026-07-01' }, ctx);
        expect(errors).toEqual([]);
        expect(warnings.some(w => w.field === 'appointmentDate')).toBe(true);
    });

    it('caps Remarks length', () => {
        const { errors } = validateRawDataRow({ ...baseRow, remarks: 'x'.repeat(501) }, ctx);
        expect(errors).toContainEqual({ field: 'remarks', message: 'Remarks exceeds 500 characters' });
    });
});
