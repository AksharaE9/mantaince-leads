import { describe, it, expect } from 'vitest';
import {
    RAW_DATA_FIELDS,
    validateRawDataRow,
    buildRawDataFilters,
    resolveRawDataSortColumn,
} from '../../../../server/src/services/rawDataImportSchema.js';
import { buildXlsxTemplate } from '../../../../server/src/services/leadImportTemplate.js';

describe('Raw Data Template & Sub-Vertical Architecture', () => {
    it('generates an XLSX workbook with all 18 template headers', async () => {
        const sampleValues = {
            date: '24-07-2026',
            employeeName: 'Jane Doe',
            productService: 'Software Solutions',
            leadName: 'Acme Enterprises',
            contactPerson: 'John Smith',
            phoneNumber: '9876543210',
            alternateNumber: '9123456780',
            city: 'Bengaluru',
            area: 'Whitefield',
            mapLocation: 'https://maps.google.com/?q=12.9716,77.5946',
            callStatus: 'Connected',
            customerResponse: 'Interested in demo',
            followUpRequired: 'Yes',
            followUpDate: '01-08-2026',
            followUpTime: '11:00 AM',
            nextAction: 'Schedule product demo',
            remarks: 'High potential lead',
            converted: 'N',
        };
        const workbook = await buildXlsxTemplate(RAW_DATA_FIELDS, ['Agent 1', 'Agent 2'], sampleValues);
        const worksheet = workbook.getWorksheet('Import Template');
        expect(worksheet).toBeDefined();

        const headers = [];
        worksheet.getRow(1).eachCell((cell) => {
            headers.push(cell.value);
        });

        expect(headers).toEqual([
            'Date', 'Employee Name', 'Product/Service', 'Lead Name', 'Contact Person',
            'Mobile Number', 'Alternate Number(If Any)', 'City', 'Area', 'Map Location',
            'Call Status', 'Customer Response', 'Follow-up Required', 'Follow-up Date',
            'Follow-up Time', 'Next Action', 'Remarks', 'Converted (Y/N)',
        ]);
    });

    it('builds SQL filters with subVerticalId scoping and all filter options', () => {
        const queryParams = {
            subVerticalId: '123e4567-e89b-12d3-a456-426614174000',
            assignedUserId: '123e4567-e89b-12d3-a456-426614174001',
            search: 'Acme',
            dateFrom: '2026-08-01',
            dateTo: '2026-08-31',
            productService: 'Software',
            city: 'Bengaluru',
            area: 'Whitefield',
            callStatus: 'Connected',
            converted: 'Y',
        };
        const { clauses, params, nextIdx } = buildRawDataFilters(queryParams, 2);

        expect(clauses).toContain('r.sub_vertical_id = $2');
        expect(clauses).toContain('r.assigned_user_id = $3');
        expect(clauses).toContain('(r.lead_name ILIKE $4 OR r.business_name ILIKE $4 OR r.contact_person ILIKE $4 OR r.phone_number ILIKE $4 OR r.alternate_number ILIKE $4)');
        expect(clauses).toContain('r.date >= $5');
        expect(clauses).toContain('r.date <= $6');
        expect(clauses).toContain('(r.product_service ILIKE $7 OR r.business_type ILIKE $7)');
        expect(clauses).toContain('r.city ILIKE $8');
        expect(clauses).toContain('r.area ILIKE $9');
        expect(clauses).toContain('r.call_status ILIKE $10');
        expect(clauses).toContain('r.converted ILIKE $11');

        expect(params).toEqual([
            '123e4567-e89b-12d3-a456-426614174000',
            '123e4567-e89b-12d3-a456-426614174001',
            '%Acme%',
            '2026-08-01',
            '2026-08-31',
            '%Software%',
            '%Bengaluru%',
            '%Whitefield%',
            '%Connected%',
            '%Y%',
        ]);
        expect(nextIdx).toBe(12);
    });

    it('resolves sorting columns accurately for new fields', () => {
        expect(resolveRawDataSortColumn('date')).toBe('r.date');
        expect(resolveRawDataSortColumn('leadName')).toBe('COALESCE(r.lead_name, r.business_name)');
        expect(resolveRawDataSortColumn('contactPerson')).toBe('r.contact_person');
        expect(resolveRawDataSortColumn('phoneNumber')).toBe('r.phone_number');
        expect(resolveRawDataSortColumn('city')).toBe('r.city');
        expect(resolveRawDataSortColumn('callStatus')).toBe('r.call_status');
        expect(resolveRawDataSortColumn('followUpDate')).toBe('r.follow_up_date');
        expect(resolveRawDataSortColumn('converted')).toBe('r.converted');
        expect(resolveRawDataSortColumn('unknownField')).toBe('r.created_at');
    });

    it('enforces Mobile Number as mandatory primary key in row validation', () => {
        const withoutPhone = {
            date: '2026-08-08',
            leadName: 'Test Business',
            productService: 'Test Product',
        };
        const res = validateRawDataRow(withoutPhone);
        expect(res.errors).toContainEqual({
            field: 'phoneNumber',
            message: 'Mobile Number is required',
        });
    });
});
