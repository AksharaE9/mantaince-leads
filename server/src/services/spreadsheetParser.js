import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

const MAX_ROWS = 10_000;

// H6: decompression-bomb guard. `workbook.xlsx.load(buffer)` fully inflates
// the entire zip and materializes every row into memory BEFORE MAX_ROWS
// (below) ever gets a chance to reject an oversized file — a compliant
// 10MB (multer's limit) xlsx can decompress to multiple GB (highly
// repetitive spreadsheet content routinely hits 1000:1+ ratios) and OOM the
// serverless function.
//
// Approach chosen: a cheap pre-check that reads the ZIP End-Of-Central-
// Directory + Central Directory records (pure metadata — no inflation) and
// sums each entry's *declared* uncompressed size, rejecting before ExcelJS
// ever touches the archive if the total exceeds a sane ceiling. A
// legitimately-structured xlsx (even one with hostile cell content) has to
// declare accurate per-entry uncompressed sizes in its central directory
// for the archive to be readable at all — that's how zip bombs are built,
// not around — so this reliably catches the "10MB zip -> multi-GB inflate"
// case without ever materializing the inflated bytes.
//
// We deliberately did NOT migrate to ExcelJS.stream.xlsx.WorkbookReader
// (the "true" streaming fix) here: this file's header-casing preservation,
// formula-result-cell unwrapping, rich-text handling, and the documented
// local-timezone Date read-back (see cellToString below) are all verified,
// previously-regressed-on behaviors (see CLAUDE.md), and re-validating all
// of that against the streaming reader's row/cell shape isn't something we
// can confidently do without running the test suite. The size-ceiling guard
// gets the same practical protection with zero risk to that logic.
const MAX_DECOMPRESSED_ZIP_BYTES = 200 * 1024 * 1024; // 200MB

function assertZipNotDecompressionBomb(buffer, maxBytes = MAX_DECOMPRESSED_ZIP_BYTES) {
    const EOCD_SIG = 0x06054b50;
    const CD_SIG = 0x02014b50;
    try {
        const maxScan = Math.min(buffer.length, 65535 + 22);
        const scanFloor = Math.max(0, buffer.length - maxScan);
        let eocdOffset = -1;
        for (let i = buffer.length - 22; i >= scanFloor; i--) {
            if (buffer.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
        }
        // Not a standard single-part zip structure we recognize — let
        // ExcelJS's own unzip step parse (and, if invalid, reject) it.
        if (eocdOffset === -1) return;

        const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
        let cdOffset = buffer.readUInt32LE(eocdOffset + 16);

        let totalUncompressed = 0;
        for (let i = 0; i < totalEntries; i++) {
            if (cdOffset + 46 > buffer.length || buffer.readUInt32LE(cdOffset) !== CD_SIG) break;
            const uncompressedSize = buffer.readUInt32LE(cdOffset + 24);
            const nameLen = buffer.readUInt16LE(cdOffset + 28);
            const extraLen = buffer.readUInt16LE(cdOffset + 30);
            const commentLen = buffer.readUInt16LE(cdOffset + 32);

            // A 0xFFFFFFFF sentinel here means the real size lives in a
            // zip64 extra field — we don't bother resolving it because the
            // raw sentinel value (~4GB) already trips the ceiling below.
            totalUncompressed += uncompressedSize;
            if (totalUncompressed > maxBytes) {
                throw Object.assign(
                    new Error('File failed a safety check: it decompresses to an implausibly large size for a spreadsheet. Please re-save it and try again.'),
                    { status: 400 }
                );
            }
            cdOffset += 46 + nameLen + extraLen + commentLen;
        }
    } catch (err) {
        if (err && err.status === 400) throw err; // our own rejection — propagate
        // Any other parsing hiccup: fail OPEN. We don't want a bug in this
        // guard's own zip-format parsing to reject a valid customer file —
        // ExcelJS will still legitimately reject anything actually malformed.
    }
}

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
    assertZipNotDecompressionBomb(buffer);
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

    const headers = [];
    const headerRow = sheet.getRow(1);
    const maxCol = headerRow.cellCount || sheet.columnCount;
    for (let c = 1; c <= maxCol; c++) {
        headers.push(cellToString(headerRow.getCell(c).value));
    }

    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const obj = {};
        let hasValue = false;
        headers.forEach((h, i) => {
            if (!h) return;
            const val = cellToString(row.getCell(i + 1).value);
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
