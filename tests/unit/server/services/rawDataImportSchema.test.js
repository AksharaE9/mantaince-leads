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
});

describe('resolveEmployeeName', () => {
    it('resolves an exact match', () => {
        expect(resolveEmployeeName('Priya Sharma', AGENTS)).toEqual({ userId: 'u3' });
    });

    it('is case-insensitive', () => {
        expect(resolveEmployeeName('priya sharma', AGENTS)).toEqual({ userId: 'u3' });
    });

    it('rejects an ambiguous partial name matching two employees, listing both', () => {
        const result = resolveEmployeeName('Rajesh', AGENTS);
        expect(result.error).toBeTruthy();
        expect(result.error).toContain('Rajesh Kumar');
        expect(result.error).toContain('Rajesh Krishnan');
        expect(result.userId).toBeUndefined();
    });

    it('never silently picks one of two ambiguous matches', () => {
        const result = resolveEmployeeName('Rajesh K', AGENTS);
        expect(result.userId).toBeUndefined();
        expect(result.error).toBeTruthy();
    });

    it('suggests closest matches for a typo with no match', () => {
        const result = resolveEmployeeName('Priya Sharm', AGENTS);
        // "Priya Sharm" is a substring-contained-in match of "Priya Sharma" — resolves cleanly.
        expect(result.userId).toBe('u3');
    });

    it('rejects and suggests closest matches for a name that resembles nobody closely', () => {
        const result = resolveEmployeeName('Zzxq Nomatch', AGENTS);
        expect(result.userId).toBeUndefined();
        expect(result.error).toContain('No matching employee found');
    });

    it('returns null userId (no error) for an empty name — employee is optional during bulk upload', () => {
        // Per CLAUDE.md: "make employeeName optional during bulk upload".
        // resolveEmployeeName returns { userId: null } for empty/whitespace input
        // rather than an error, because the caller (validateRawDataRow) treats
        // a missing employee as a valid state (leads it to its own check).
        const emptyResult = resolveEmployeeName('', AGENTS);
        expect(emptyResult.userId).toBeNull();
        expect(emptyResult.error).toBeUndefined();

        const blankResult = resolveEmployeeName('   ', AGENTS);
        expect(blankResult.userId).toBeNull();
        expect(blankResult.error).toBeUndefined();
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

    it('requires Date, Employee Name, Business Name, and Phone Number', () => {
        const { errors } = validateRawDataRow({ ...baseRow, date: '', businessName: '', phoneNumber: '' }, ctx);
        const fields = errors.map(e => e.field);
        expect(fields).toContain('date');
        expect(fields).toContain('businessName');
        expect(fields).toContain('phoneNumber');
    });

    it('does not require Area, City, Address, Appointment Date/Timings, Remarks, or Business Type', () => {
        const { errors } = validateRawDataRow({
            ...baseRow, area: '', city: '', address: '', appointmentDate: '', appointmentTimings: '', remarks: '', businessType: '',
        }, ctx);
        expect(errors).toEqual([]);
    });

    it('rejects an invalid phone number', () => {
        const { errors } = validateRawDataRow({ ...baseRow, phoneNumber: 'not-a-phone' }, ctx);
        expect(errors).toContainEqual({ field: 'phoneNumber', message: 'Phone Number is not a valid phone number' });
    });

    it('rejects an unparseable date', () => {
        const { errors } = validateRawDataRow({ ...baseRow, date: 'not-a-date' }, ctx);
        expect(errors.some(e => e.field === 'date')).toBe(true);
    });

    it('rejects an employee name that cannot be resolved', () => {
        const { errors, assignedUserId } = validateRawDataRow({ ...baseRow, employeeName: 'Nobody Here' }, ctx);
        expect(errors.some(e => e.field === 'employeeName')).toBe(true);
        expect(assignedUserId).toBeNull();
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
