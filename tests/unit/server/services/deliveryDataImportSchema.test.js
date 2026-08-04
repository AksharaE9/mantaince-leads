import { describe, it, expect } from 'vitest';
import {
    DELIVERY_DATA_FIELDS,
    validateDeliveryDataRow,
    resolveLinkedRawDataId,
} from '../../../../server/src/services/deliveryDataImportSchema.js';

const AGENTS = [
    { id: 'u1', name: 'Rajesh Kumar' },
    { id: 'u2', name: 'Rajesh Krishnan' },
    { id: 'u3', name: 'Priya Sharma' },
];

describe('DELIVERY_DATA_FIELDS', () => {
    it('has the 11 shared Raw Data fields plus Delivery Date/Delivery Time appended at the end, in order', () => {
        expect(DELIVERY_DATA_FIELDS.map(f => f.key)).toEqual([
            'date', 'employeeName', 'businessType', 'businessName', 'area', 'city',
            'phoneNumber', 'address', 'appointmentDate', 'appointmentTimings', 'remarks',
            'deliveryDate', 'deliveryTime',
        ]);
    });

    it('marks Delivery Date and Delivery Time as optional', () => {
        const deliveryDate = DELIVERY_DATA_FIELDS.find(f => f.key === 'deliveryDate');
        const deliveryTime = DELIVERY_DATA_FIELDS.find(f => f.key === 'deliveryTime');
        expect(deliveryDate.required).toBe(false);
        expect(deliveryTime.required).toBe(false);
        expect(deliveryDate.type).toBe('date');
    });

    it('never includes a vertical/businessVertical or linkedRawDataId column — those are never template columns', () => {
        expect(DELIVERY_DATA_FIELDS.some(f => /vertical/i.test(f.key) || /linkedrawdata/i.test(f.key))).toBe(false);
    });
});

describe('validateDeliveryDataRow', () => {
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
        deliveryDate: '2026-08-05',
        deliveryTime: '2:00 PM - 3:00 PM',
    };
    const ctx = { agents: AGENTS, knownBusinessTypes: new Set(['retail', 'wholesale']) };

    it('accepts a fully valid row with no errors or warnings', () => {
        const { errors, warnings, assignedUserId } = validateDeliveryDataRow(baseRow, ctx);
        expect(errors).toEqual([]);
        expect(warnings).toEqual([]);
        expect(assignedUserId).toBe('u3');
    });

    // Phone-number-only-mandatory policy (see CLAUDE.md): reuses the shared
    // Raw Data validator, which now only hard-requires Phone Number — a blank
    // Date/Business Name/Employee Name is accepted (warned on where
    // applicable), matching every other section.
    it('reuses the shared-field validator: requires only Phone Number; blank Date/Business Name/unresolved Employee Name warn instead of block', () => {
        const { errors, warnings } = validateDeliveryDataRow({ ...baseRow, date: '', businessName: '', phoneNumber: '', employeeName: 'Nobody Here' }, ctx);
        const errorFields = errors.map(e => e.field);
        expect(errorFields).toEqual(['phoneNumber']);
        expect(warnings.some(w => w.field === 'employeeName')).toBe(true);
    });

    it('does not require Delivery Date', () => {
        const { errors } = validateDeliveryDataRow({ ...baseRow, deliveryDate: '' }, ctx);
        expect(errors.some(e => e.field === 'deliveryDate')).toBe(false);
    });

    // Step 3 of the phone-number-only-mandatory policy: a present-but-
    // unparseable Delivery Date is a warning, not a hard reject — the row
    // still inserts with that field left blank. This is the exact field/
    // error message ("Delivery Date is not a valid date") that hard-blocked
    // all 55 rows of the real Delivery Data upload this fix responds to.
    it('warns (does not reject) on an unparseable Delivery Date', () => {
        const { errors, warnings } = validateDeliveryDataRow({ ...baseRow, deliveryDate: 'not-a-date' }, ctx);
        expect(errors.some(e => e.field === 'deliveryDate')).toBe(false);
        expect(warnings.some(w => w.field === 'deliveryDate')).toBe(true);
    });

    it('parses the real-world DD-MM-YY / DD-MM-YYYY dash formats from the failed upload with no "unparseable" warning', () => {
        // deliberately on/after baseRow's Date and Appointment Date so this
        // isolates the parse check from the separate "earlier than" warning.
        const { warnings } = validateDeliveryDataRow({ ...baseRow, deliveryDate: '05-08-2026' }, ctx);
        expect(warnings.some(w => w.field === 'deliveryDate' && /could not be parsed/.test(w.message))).toBe(false);
    });

    it('does not require Delivery Time', () => {
        const { errors } = validateDeliveryDataRow({ ...baseRow, deliveryTime: '' }, ctx);
        expect(errors.some(e => e.field === 'deliveryTime')).toBe(false);
    });

    it('accepts a Delivery Time range string, same free-text convention as Appointment Timings', () => {
        const { errors } = validateDeliveryDataRow({ ...baseRow, deliveryTime: '10 AM - 12 PM' }, ctx);
        expect(errors).toEqual([]);
    });

    it('caps Delivery Time length', () => {
        const { errors } = validateDeliveryDataRow({ ...baseRow, deliveryTime: 'x'.repeat(101) }, ctx);
        expect(errors).toContainEqual({ field: 'deliveryTime', message: 'Delivery Time exceeds 100 characters' });
    });

    it('warns (does not reject) when Delivery Date is earlier than the visit Date', () => {
        const { errors, warnings } = validateDeliveryDataRow({ ...baseRow, date: '2026-08-10', deliveryDate: '2026-08-05' }, ctx);
        expect(errors).toEqual([]);
        expect(warnings.some(w => w.field === 'deliveryDate' && /earlier than the visit Date/.test(w.message))).toBe(true);
    });

    it('warns (does not reject) when Delivery Date is earlier than the Appointment Date', () => {
        const { errors, warnings } = validateDeliveryDataRow({ ...baseRow, date: '2026-07-01', appointmentDate: '2026-08-10', deliveryDate: '2026-08-05' }, ctx);
        expect(errors).toEqual([]);
        expect(warnings.some(w => w.field === 'deliveryDate' && /earlier than the Appointment Date/.test(w.message))).toBe(true);
    });

    it('does not warn when Delivery Date is on/after both Date and Appointment Date', () => {
        const { warnings } = validateDeliveryDataRow(baseRow, ctx);
        expect(warnings.some(w => w.field === 'deliveryDate')).toBe(false);
    });
});

describe('resolveLinkedRawDataId', () => {
    it('links on an exact, unambiguous phone match (high confidence)', () => {
        const phoneMap = new Map([['9876543210', ['raw-1']]]);
        const nameMap = new Map();
        const result = resolveLinkedRawDataId('9876543210', 'Acme Traders', { phoneMap, nameMap });
        expect(result).toEqual({ linkedRawDataId: 'raw-1', matchType: 'phone', confidence: 'high' });
    });

    it('does not link on an ambiguous phone match — flags it instead of guessing', () => {
        const phoneMap = new Map([['9876543210', ['raw-1', 'raw-2']]]);
        const result = resolveLinkedRawDataId('9876543210', 'Acme Traders', { phoneMap, nameMap: new Map() });
        expect(result.linkedRawDataId).toBeNull();
        expect(result.confidence).toBe('ambiguous');
        expect(result.warning).toContain('not auto-linked');
    });

    it('falls back to an exact, unambiguous business-name match when phone does not match (medium confidence)', () => {
        const nameMap = new Map([['acme traders', ['raw-3']]]);
        const result = resolveLinkedRawDataId('0000000000', 'Acme Traders', { phoneMap: new Map(), nameMap });
        expect(result).toEqual({ linkedRawDataId: 'raw-3', matchType: 'business_name', confidence: 'medium' });
    });

    it('does not link on an ambiguous business-name match', () => {
        const nameMap = new Map([['acme traders', ['raw-3', 'raw-4']]]);
        const result = resolveLinkedRawDataId('0000000000', 'Acme Traders', { phoneMap: new Map(), nameMap });
        expect(result.linkedRawDataId).toBeNull();
        expect(result.confidence).toBe('ambiguous');
    });

    it('is not linked (with an informational warning) when nothing matches — a standalone row is equally valid', () => {
        const result = resolveLinkedRawDataId('0000000000', 'Nobody Traders', { phoneMap: new Map(), nameMap: new Map() });
        expect(result.linkedRawDataId).toBeNull();
        expect(result.matchType).toBeNull();
        expect(result.warning).toContain('standalone Delivery Data row');
    });

    it('prioritizes phone match over business-name match', () => {
        const phoneMap = new Map([['9876543210', ['raw-1']]]);
        const nameMap = new Map([['acme traders', ['raw-9']]]);
        const result = resolveLinkedRawDataId('9876543210', 'Acme Traders', { phoneMap, nameMap });
        expect(result.linkedRawDataId).toBe('raw-1');
        expect(result.matchType).toBe('phone');
    });
});
