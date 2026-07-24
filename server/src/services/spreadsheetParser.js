import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

const MAX_ROWS = 10_000;

const pad2 = (n) => String(n).padStart(2, '0');

function cellToString(cellValue) {
    if (cellValue === undefined || cellValue === null) return '';
    if (cellValue instanceof Date) {
        // exceljs constructs date-cell values using the local (server)
        // timezone, not UTC — .toISOString() would read back the UTC
        // instant and roll the date back a day for any timezone ahead of
        // UTC (e.g. IST). Local getters match how the Date was built.
        return `${cellValue.getFullYear()}-${pad2(cellValue.getMonth() + 1)}-${pad2(cellValue.getDate())}`;
    }
    if (typeof cellValue === 'object') {
        // Rich text run
        if (Array.isArray(cellValue.richText)) return cellValue.richText.map(t => t.text).join('');
        // Formula cell — use the last computed result, never the formula string
        if (cellValue.result !== undefined) return cellToString(cellValue.result);
        // Hyperlink
        if (cellValue.text !== undefined) return String(cellValue.text);
        return '';
    }
    return String(cellValue).trim();
}

async function parseXlsxBuffer(buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const warnings = [];
    const sheet = workbook.worksheets[0];
    if (!sheet) {
        return { rows: [], warnings: ['The workbook has no sheets.'] };
    }
    if (workbook.worksheets.length > 1) {
        warnings.push(`The file contains ${workbook.worksheets.length} sheets — only the first sheet ("${sheet.name}") was imported.`);
    }

    let headers = null;
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const rawValues = row.values.slice(1); // exceljs rows are 1-indexed with a leading empty slot
        if (rowNumber === 1) {
            // Keep original header casing — normalizeRowKeys() downstream
            // does the case-insensitive matching. Preserving it here means
            // error reports (originalRow) show the user's own header text.
            headers = rawValues.map(v => cellToString(v));
            return;
        }
        const obj = {};
        let hasValue = false;
        headers.forEach((h, i) => {
            if (!h) return;
            const val = cellToString(rawValues[i]);
            if (val !== '') hasValue = true;
            obj[h] = val;
        });
        if (hasValue) rows.push(obj);
    });

    return { rows, warnings };
}

/**
 * Parses an uploaded lead-import file (CSV or Excel) into an array of
 * plain row objects keyed by original (as-typed) header text, plus any
 * non-fatal warnings (e.g. "only the first sheet was used"). Row objects
 * are shaped identically regardless of source format so the rest of the
 * import pipeline (normalizeRowKeys, validation, dedup, insert) doesn't
 * need to know or care which file type was uploaded.
 */
export async function parseUploadBuffer(buffer, fileExt) {
    const ext = (fileExt || '.csv').toLowerCase();

    if (ext === '.xlsx' || ext === '.xls') {
        const { rows, warnings } = await parseXlsxBuffer(buffer);
        if (rows.length > MAX_ROWS) {
            throw Object.assign(new Error(`File has ${rows.length} rows, which exceeds the ${MAX_ROWS.toLocaleString()} row limit. Please split it into smaller files.`), { status: 400 });
        }
        return { rows, warnings };
    }

    // csv-parse strips a leading UTF-8 BOM and handles both \n and \r\n line endings natively.
    // Headers keep their original casing here too (see xlsx branch above) —
    // normalizeRowKeys() downstream does the case-insensitive matching.
    const rows = parse(buffer, { columns: true, trim: true, skip_empty_lines: true, bom: true });
    if (rows.length > MAX_ROWS) {
        throw Object.assign(new Error(`File has ${rows.length} rows, which exceeds the ${MAX_ROWS.toLocaleString()} row limit. Please split it into smaller files.`), { status: 400 });
    }
    return { rows, warnings: [] };
}

export default parseUploadBuffer;
