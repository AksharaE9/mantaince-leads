// Client-side pre-validation for bulk lead imports (CSV/Excel).
//
// Mirrors server/src/services/leadImportSchema.js#validateRowAgainstSchema —
// same schema (fetched from GET /leads/csv/schema/:verticalId), same rules —
// so the fast client-side preview and the authoritative server-side
// validator can never disagree about what's valid. This is UX speed only;
// the server always re-validates every row regardless of what this reports.

const IMPORT_PHONE_REGEX = /^\+?\d{7,15}$/;

export const normalizeHeaderKey = (k) =>
  String(k).toLowerCase().trim().replace(/\r?\n/g, ' ').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ');

export function validateParsedRowsAgainstSchema(rows, schema) {
  let validCount = 0;
  const rowErrors = [];

  rows.forEach((row, idx) => {
    const errors = [];
    schema.forEach((field) => {
      const headerKey = normalizeHeaderKey(field.csvHeader || field.label);
      const raw = row[headerKey];
      const value = raw === undefined || raw === null ? '' : String(raw).trim();

      if (field.required && !value) {
        errors.push({ field: field.key, message: `${field.label} is required` });
        return;
      }
      if (!value) return;

      if (field.type === 'phone' && !IMPORT_PHONE_REGEX.test(value.replace(/[^\d+]/g, ''))) {
        errors.push({ field: field.key, message: `${field.label} is not a valid phone number` });
      }
      if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        errors.push({ field: field.key, message: `${field.label} is not a valid email address` });
      }
      if (field.type === 'enum' && field.options?.length && !field.options.some((o) => o.toLowerCase() === value.toLowerCase())) {
        errors.push({ field: field.key, message: `"${value}" is not a valid ${field.label} option` });
      }
    });

    if (errors.length === 0) {
      validCount += 1;
    } else {
      rowErrors.push({ row: idx + 2, errors }); // +2: 1-based + header row
    }
  });

  return { totalRows: rows.length, validCount, invalidCount: rowErrors.length, rowErrors };
}
