// Client-side pre-validation for bulk lead imports (CSV/Excel).

const IMPORT_PHONE_REGEX = /^\+?\d{7,15}$/;

export const normalizeHeaderKey = (k) =>
  String(k || '')
    .toLowerCase()
    .trim()
    .replace(/\r?\n/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ');

// Clean key for loose matching (ignores non-alphanumeric characters)
export const canonicalKey = (k) =>
  String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function validateParsedRowsAgainstSchema(rows, schema) {
  let validCount = 0;
  const rowErrors = [];

  // Build a lookup map of schema field canonical keys
  const schemaMap = schema.map((field) => ({
    field,
    canonicalCsvHeader: canonicalKey(field.csvHeader || field.label),
    canonicalKey: canonicalKey(field.key),
    normalizedCsvHeader: normalizeHeaderKey(field.csvHeader || field.label),
  }));

  const previewMappedRows = rows.slice(0, 5).map((row) => {
    const rowCanonicalMap = {};
    Object.entries(row).forEach(([k, v]) => {
      rowCanonicalMap[canonicalKey(k)] = v;
      rowCanonicalMap[normalizeHeaderKey(k)] = v;
    });

    const mapped = {};
    schema.forEach((field) => {
      const match = schemaMap.find((s) => s.field.key === field.key);
      const val = rowCanonicalMap[match.normalizedCsvHeader] !== undefined
        ? rowCanonicalMap[match.normalizedCsvHeader]
        : (rowCanonicalMap[match.canonicalCsvHeader] !== undefined
          ? rowCanonicalMap[match.canonicalCsvHeader]
          : (rowCanonicalMap[match.canonicalKey] !== undefined
            ? rowCanonicalMap[match.canonicalKey]
            : ''));
      mapped[field.key] = val === undefined || val === null ? '' : String(val).trim();
    });
    return mapped;
  });

  rows.forEach((row, idx) => {
    const errors = [];
    const rowCanonicalMap = {};
    Object.entries(row).forEach(([k, v]) => {
      rowCanonicalMap[canonicalKey(k)] = v;
      rowCanonicalMap[normalizeHeaderKey(k)] = v;
    });

    schema.forEach((field) => {
      const match = schemaMap.find((s) => s.field.key === field.key);
      const raw = rowCanonicalMap[match.normalizedCsvHeader] !== undefined
        ? rowCanonicalMap[match.normalizedCsvHeader]
        : (rowCanonicalMap[match.canonicalCsvHeader] !== undefined
          ? rowCanonicalMap[match.canonicalCsvHeader]
          : (rowCanonicalMap[match.canonicalKey] !== undefined
            ? rowCanonicalMap[match.canonicalKey]
            : ''));

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
    });

    if (errors.length === 0) {
      validCount += 1;
    } else {
      rowErrors.push({ row: idx + 2, errors }); // +2: 1-based + header row
    }
  });

  return {
    totalRows: rows.length,
    validCount,
    invalidCount: rowErrors.length,
    rowErrors,
    previewMappedRows,
    schemaFields: schema,
  };
}

export function validateParsedRowsWithMapping(rows, schema, columnMapping) {
  let validCount = 0;
  const rowErrors = [];

  const previewMappedRows = rows.slice(0, 5).map((row) => {
    const mapped = {};
    schema.forEach((field) => {
      const fileHeader = columnMapping[field.key];
      const lookupKey = fileHeader ? normalizeHeaderKey(fileHeader) : '';
      const val = lookupKey ? row[lookupKey] : '';
      mapped[field.key] = val === undefined || val === null ? '' : String(val).trim();
    });
    return mapped;
  });

  rows.forEach((row, idx) => {
    const errors = [];
    schema.forEach((field) => {
      const fileHeader = columnMapping[field.key];
      const lookupKey = fileHeader ? normalizeHeaderKey(fileHeader) : '';
      const raw = lookupKey ? row[lookupKey] : '';
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
    });

    if (errors.length === 0) {
      validCount += 1;
    } else {
      rowErrors.push({ row: idx + 2, errors });
    }
  });

  return {
    totalRows: rows.length,
    validCount,
    invalidCount: rowErrors.length,
    rowErrors,
    previewMappedRows,
    schemaFields: schema,
  };
}
