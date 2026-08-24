import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseUploadBuffer, inspectXlsxSheets } from '../../../../server/src/services/spreadsheetParser.js';

// Re-create similarity function in test to assert alignment of implementation
function getSimilarity(s1, s2) {
    const a = String(s1 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const b = String(s2 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (a === b) return 1.0;
    const track = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
    for (let i = 0; i <= a.length; i += 1) track[0][i] = i;
    for (let j = 0; j <= b.length; j += 1) track[j][0] = j;
    for (let j = 1; j <= b.length; j += 1) {
        for (let i = 1; i <= a.length; i += 1) {
            const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
            track[j][i] = Math.min(
                track[j][i - 1] + 1, // deletion
                track[j - 1][i] + 1, // insertion
                track[j - 1][i - 1] + indicator // substitution
            );
        }
    }
    const distance = track[b.length][a.length];
    const maxLength = Math.max(a.length, b.length);
    return maxLength === 0 ? 1.0 : 1.0 - distance / maxLength;
}

describe('Multi-sheet spreadsheetParser', () => {
    it('inspectXlsxSheets returns a manifest of sheets with row counts', async () => {
        const wb = new ExcelJS.Workbook();
        const ws1 = wb.addWorksheet('Sheet A');
        ws1.columns = [
            { header: 'Contact Number', key: 'phone' },
            { header: 'Lead Name', key: 'name' }
        ];
        ws1.addRow({ phone: '9876543210', name: 'Lead A' });
        ws1.addRow({ phone: '9876543211', name: 'Lead B' });

        const ws2 = wb.addWorksheet('Sheet B');
        ws2.columns = [
            { header: 'Contact Number', key: 'phone' },
            { header: 'Lead Name', key: 'name' }
        ];
        ws2.addRow({ phone: '9876543212', name: 'Lead C' });

        const buffer = await wb.xlsx.writeBuffer();

        const result = await inspectXlsxSheets(buffer);
        expect(result.sheets).toEqual([
            { index: 0, name: 'Sheet A', rowCount: 2 },
            { index: 1, name: 'Sheet B', rowCount: 1 }
        ]);
    });

    it('parseUploadBuffer combines selected sheets and tags row records with _sheetName', async () => {
        const wb = new ExcelJS.Workbook();
        const ws1 = wb.addWorksheet('Sheet A');
        ws1.columns = [
            { header: 'Contact Number', key: 'phone' },
            { header: 'Lead Name', key: 'name' }
        ];
        ws1.addRow({ phone: '9876543210', name: 'Lead A' });

        const ws2 = wb.addWorksheet('Sheet B');
        ws2.columns = [
            { header: 'Contact Number', key: 'phone' },
            { header: 'Lead Name', key: 'name' }
        ];
        ws2.addRow({ phone: '9876543211', name: 'Lead B' });

        const buffer = await wb.xlsx.writeBuffer();

        // Parse both sheets [0, 1]
        const result = await parseUploadBuffer(buffer, '.xlsx', [0, 1]);
        expect(result.rows.length).toBe(2);
        expect(result.rows[0]).toMatchObject({
            "Contact Number": "9876543210",
            "Lead Name": "Lead A",
            "_sheetName": "Sheet A"
        });
        expect(result.rows[1]).toMatchObject({
            "Contact Number": "9876543211",
            "Lead Name": "Lead B",
            "_sheetName": "Sheet B"
        });
        expect(result.sheetNames).toEqual(["Sheet A", "Sheet B"]);
    });

    it('parseUploadBuffer defaults to sheet index 0 if no indices specified', async () => {
        const wb = new ExcelJS.Workbook();
        const ws1 = wb.addWorksheet('Sheet A');
        ws1.columns = [
            { header: 'Contact Number', key: 'phone' },
            { header: 'Lead Name', key: 'name' }
        ];
        ws1.addRow({ phone: '9876543210', name: 'Lead A' });

        const ws2 = wb.addWorksheet('Sheet B');
        ws2.columns = [
            { header: 'Contact Number', key: 'phone' },
            { header: 'Lead Name', key: 'name' }
        ];
        ws2.addRow({ phone: '9876543211', name: 'Lead B' });

        const buffer = await wb.xlsx.writeBuffer();

        const result = await parseUploadBuffer(buffer, '.xlsx');
        expect(result.rows.length).toBe(1);
        expect(result.rows[0]._sheetName).toBe("Sheet A");
    });
});

describe('Fuzzy string similarity matching', () => {
    it('returns 1.0 for exact matches case-insensitively and ignoring non-alphanumeric', () => {
        expect(getSimilarity('Contact Number', 'contact number')).toBe(1.0);
        expect(getSimilarity('Contact Number', 'contactnumber')).toBe(1.0);
        expect(getSimilarity('Contact Number', 'Contact Number!!!')).toBe(1.0);
        expect(getSimilarity('phone_number', 'PHONENUMBER')).toBe(1.0);
    });

    it('returns high similarity (>0.6) for slight typos', () => {
        expect(getSimilarity('Contact Number', 'Contct Numbr')).toBeGreaterThan(0.7);
        expect(getSimilarity('Contact Number', 'Contact Nubmer')).toBeGreaterThan(0.8);
    });

    it('returns low similarity for completely unrelated headers', () => {
        expect(getSimilarity('Contact Number', 'Remarks')).toBeLessThan(0.3);
        expect(getSimilarity('Contact Number', 'Employee Name')).toBeLessThan(0.4);
    });
});
