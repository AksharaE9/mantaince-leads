import { describe, it, expect } from 'vitest';
import { RAW_DATA_FIELDS, validateRawDataRow, resolveEmployeeName } from '../../../../server/src/services/rawDataImportSchema.js';

const AGENTS = [
    { id: 'u1', name: 'Rajesh Kumar' },
    { id: 'u2', name: 'Rajesh Krishnan' },
    { id: 'u3', name: 'Priya Sharma' },
];

describe('RAW_DATA_FIELDS', () => {
    it('has all 18 template fields in the exact template order from Excel photo', () => {
        expect(RAW_DATA_FIELDS.map(f => f.key)).toEqual([
            'date', 'employeeName', 'productService', 'leadName', 'contactPerson',
            'phoneNumber', 'alternateNumber', 'city', 'area', 'mapLocation',
            'callStatus', 'customerResponse', 'followUpRequired', 'followUpDate',
            'followUpTime', 'nextAction', 'remarks', 'converted',
        ]);
    });

    it('has correct labels and headers matching Excel photos', () => {
        const phone = RAW_DATA_FIELDS.find(f => f.key === 'phoneNumber');
        const alt = RAW_DATA_FIELDS.find(f => f.key === 'alternateNumber');
        const prod = RAW_DATA_FIELDS.find(f => f.key === 'productService');
        const conv = RAW_DATA_FIELDS.find(f => f.key === 'converted');
        expect(phone.label).toBe('Contact Number');
        expect(alt.label).toBe('Alternate Number(If Any)');
        expect(prod.label).toBe('Product/Service');
        expect(conv.label).toBe('Converted (Y/N)');
    });

    it('never includes a vertical/businessVertical column — it is auto-assigned from context', () => {
        expect(RAW_DATA_FIELDS.some(f => /vertical/i.test(f.key) || /vertical/i.test(f.label))).toBe(false);
    });

    it('marks only phoneNumber (Contact Number) as required — every other field is optional', () => {
        const required = RAW_DATA_FIELDS.filter(f => f.required).map(f => f.key);
        expect(required).toEqual(['phoneNumber']);
    });
});

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

    it('leaves an ambiguous partial name unresolved with a warning listing both, never blocks', () => {
        const result = resolveEmployeeName('Rajesh', AGENTS);
        expect(result.userId).toBeNull();
        expect(result.rawName).toBe('Rajesh');
        expect(result.warning).toBeTruthy();
        expect(result.warning).toContain('Rajesh Kumar');
        expect(result.warning).toContain('Rajesh Krishnan');
    });

    it('suggests closest matches for a typo with no match', () => {
        const result = resolveEmployeeName('Priya Sharm', AGENTS);
        expect(result.userId).toBe('u3');
        expect(result.warning).toBeTruthy();
    });

    it('leaves unresolved (never blocks) a name that resembles nobody closely', () => {
        const result = resolveEmployeeName('Zzxq Nomatch', AGENTS);
        expect(result.userId).toBeNull();
        expect(result.rawName).toBe('Zzxq Nomatch');
        expect(result.warning).toContain('No matching employee found');
    });

    it('returns null userId and no warning for an empty name', () => {
        const emptyResult = resolveEmployeeName('', AGENTS);
        expect(emptyResult.userId).toBeNull();
        expect(emptyResult.rawName).toBe('');
        expect(emptyResult.warning).toBeUndefined();
    });
});

describe('validateRawDataRow', () => {
    const baseRow = {
        date: '2026-07-24',
        employeeName: 'Priya Sharma',
        productService: 'Software',
        leadName: 'Acme Traders',
        contactPerson: 'John Smith',
        phoneNumber: '9876543210',
        alternateNumber: '9876543211',
        city: 'Bengaluru',
        area: 'Whitefield',
        mapLocation: 'https://maps.google.com/?q=12,77',
        callStatus: 'Connected',
        customerResponse: 'Interested',
        followUpRequired: 'Yes',
        followUpDate: '2026-08-01',
        followUpTime: '11:00 AM',
        nextAction: 'Demo',
        remarks: 'Great lead',
        converted: 'N',
    };
    const ctx = { agents: AGENTS, knownBusinessTypes: new Set(['software', 'retail']) };

    it('accepts a fully valid row with no errors or warnings', () => {
        const { errors, warnings, assignedUserId } = validateRawDataRow(baseRow, ctx);
        expect(errors).toEqual([]);
        expect(warnings).toEqual([]);
        expect(assignedUserId).toBe('u3');
    });

    it('requires only Contact Number — blank Date and Lead Name are accepted with no error', () => {
        const { errors } = validateRawDataRow({ ...baseRow, date: '', leadName: '', phoneNumber: '' }, ctx);
        const fields = errors.map(e => e.field);
        expect(fields).toEqual(['phoneNumber']);
    });

    it('does not require optional fields', () => {
        const { errors } = validateRawDataRow({
            phoneNumber: '9876543210',
        }, ctx);
        expect(errors).toEqual([]);
    });

    it('rejects an invalid phone number', () => {
        const { errors } = validateRawDataRow({ ...baseRow, phoneNumber: 'not-a-phone' }, ctx);
        expect(errors).toContainEqual({ field: 'phoneNumber', message: 'Contact Number is not a valid phone number' });
    });

    it('warns (does not reject) on an unparseable date', () => {
        const { errors, warnings } = validateRawDataRow({ ...baseRow, date: 'not-a-date' }, ctx);
        expect(errors.some(e => e.field === 'date')).toBe(false);
        expect(warnings.some(w => w.field === 'date')).toBe(true);
    });

    it('parses DD-MM-YYYY and DD-MM-YY dash-separated dates with no warning', () => {
        const { warnings: w1 } = validateRawDataRow({ ...baseRow, date: '23-06-26' }, ctx);
        expect(w1.some(w => w.field === 'date')).toBe(false);

        const { warnings: w2 } = validateRawDataRow({ ...baseRow, date: '26-06-2026' }, ctx);
        expect(w2.some(w => w.field === 'date')).toBe(false);
    });

    it('warns (does not reject) on an employee name that cannot be resolved', () => {
        const { errors, warnings, assignedUserId, employeeNameRaw } = validateRawDataRow({ ...baseRow, employeeName: 'Nobody Here' }, ctx);
        expect(errors.some(e => e.field === 'employeeName')).toBe(false);
        expect(warnings.some(w => w.field === 'employeeName')).toBe(true);
        expect(assignedUserId).toBeNull();
        expect(employeeNameRaw).toBe('Nobody Here');
    });

    it('flags (does not reject) a new Product/Service not seen before', () => {
        const { errors, warnings } = validateRawDataRow({ ...baseRow, productService: 'Pharmacy Chain' }, ctx);
        expect(errors).toEqual([]);
        expect(warnings).toContainEqual({
            field: 'productService',
            message: '"Pharmacy Chain" is a new Product/Service not seen before — accepted, flagged for review',
        });
    });

    it('warns (does not reject) when Follow-up Date is before record Date', () => {
        const { errors, warnings } = validateRawDataRow({ ...baseRow, date: '2026-08-01', followUpDate: '2026-07-01' }, ctx);
        expect(errors).toEqual([]);
        expect(warnings.some(w => w.field === 'followUpDate')).toBe(true);
    });

    it('caps Remarks length', () => {
        const { errors } = validateRawDataRow({ ...baseRow, remarks: 'x'.repeat(501) }, ctx);
        expect(errors).toContainEqual({ field: 'remarks', message: 'Remarks exceeds 500 characters' });
    });
});
