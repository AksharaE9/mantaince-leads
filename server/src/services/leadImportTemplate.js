import ExcelJS from 'exceljs';

const MAX_DATA_ROWS = 500; // rows to pre-apply dropdown validation to
const INLINE_LIST_MAX_CHARS = 250; // Excel inline list formula literal limit is 255 chars

function columnLetter(oneBasedIndex) {
    let n = oneBasedIndex;
    let letter = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        letter = String.fromCharCode(65 + rem) + letter;
        n = Math.floor((n - 1) / 26);
    }
    return letter;
}

/**
 * Builds an .xlsx workbook for the given lead-import schema.
 *
 * - Row 1: field labels (bold; required fields additionally highlighted).
 * - Row 2: one realistic sample row.
 * - Enum-typed fields (and the Employee Name column, backed by the live
 *   agent list) get real Excel dropdown validation so users can't typo an
 *   invalid value. Long option lists overflow onto a hidden reference
 *   sheet since Excel's inline list literal is capped at 255 characters.
 */
export async function buildXlsxTemplate(schema, agentNames = [], sampleValues = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'LeadsBase';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Import Template', {
        views: [{ state: 'frozen', ySplit: 1 }],
    });
    const listSheet = workbook.addWorksheet('Lists');
    listSheet.state = 'veryHidden';

    // ── Header row ──────────────────────────────────────────────────────
    const headerRow = sheet.addRow(schema.map(f => f.label));
    headerRow.height = 20;
    headerRow.eachCell((cell, colNumber) => {
        const field = schema[colNumber - 1];
        cell.font = { bold: true };
        if (field.required) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
            cell.note = 'Required';
        } else {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
        }
    });

    // ── Sample row ──────────────────────────────────────────────────────
    const sampleRowValues = schema.map(f => sampleValues[f.key] ?? (f.type === 'enum' ? (f.options?.[0] || '') : ''));
    const sampleRow = sheet.addRow(sampleRowValues);
    sampleRow.eachCell(cell => {
        cell.font = { italic: true, color: { argb: 'FF808080' } };
    });

    // ── Column widths ───────────────────────────────────────────────────
    schema.forEach((f, i) => {
        sheet.getColumn(i + 1).width = Math.min(40, Math.max(16, f.label.length + 2));
    });

    // ── Dropdown validation ─────────────────────────────────────────────
    let nextListColumn = 1;
    schema.forEach((field, idx) => {
        let options = null;
        if (field.type === 'enum' && field.options?.length) {
            options = field.options;
        } else if (field.key === 'employeeName' && agentNames.length) {
            options = agentNames;
        }
        if (!options || options.length === 0) return;

        const colLetter = columnLetter(idx + 1);
        let formula;

        if (options.join(',').length <= INLINE_LIST_MAX_CHARS && options.length <= 50) {
            formula = `"${options.join(',')}"`;
        } else {
            const listColLetter = columnLetter(nextListColumn++);
            options.forEach((opt, i) => {
                listSheet.getCell(`${listColLetter}${i + 1}`).value = opt;
            });
            formula = `Lists!$${listColLetter}$1:$${listColLetter}$${options.length}`;
        }

        for (let row = 2; row <= MAX_DATA_ROWS; row++) {
            sheet.getCell(`${colLetter}${row}`).dataValidation = {
                type: 'list',
                allowBlank: !field.required,
                formulae: [formula],
                showErrorMessage: true,
                errorStyle: 'warning',
                errorTitle: 'Invalid value',
                error: `Please choose a value from the dropdown list for "${field.label}".`,
            };
        }
    });

    return workbook;
}

export default buildXlsxTemplate;
