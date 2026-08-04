import { describe, it, expect } from 'vitest';
import { buildXlsxTemplate } from '../../../../server/src/services/leadImportTemplate.js';
import { RAW_DATA_FIELDS } from '../../../../server/src/services/rawDataImportSchema.js';
import { DELIVERY_DATA_FIELDS } from '../../../../server/src/services/deliveryDataImportSchema.js';
import { BASE_FIELDS_CALL, BASE_FIELDS_POSITIVE } from '../../../../server/src/services/leadImportSchema.js';

const REQUIRED_FILL = 'FFFFC7CE';

// Reads back exactly what buildXlsxTemplate wrote — no re-parsing of a
// serialized buffer needed, since buildXlsxTemplate returns the live
// ExcelJS Workbook object itself. Provable source-of-truth check: this
// reads the ACTUAL generated header-row fill colors, not the schema's
// `required` flags a second time — if the template generator ever grows a
// separate hardcoded "required fields" list that drifts from
// `field.required`, this test fails.
function highlightedLabels(workbook, schema) {
    const sheet = workbook.getWorksheet('Import Template');
    const headerRow = sheet.getRow(1);
    const labels = [];
    schema.forEach((f, i) => {
        const fill = headerRow.getCell(i + 1).fill?.fgColor?.argb;
        if (fill === REQUIRED_FILL) labels.push(f.label);
    });
    return labels;
}

// Safeguard against the phone-only-mandatory policy silently drifting back
// out of sync between the schema and the generated template (this exact
// class of bug shipped once — schema said required:false, but a stale
// deploy/branch made the live template disagree; this test can't catch an
// undeployed-fix problem, but it does prove the *code path* is correct so a
// future schema edit can't reintroduce a hardcoded-list-style drift).
describe('buildXlsxTemplate — required-field highlighting is derived from schema.required, not a separate list', () => {
    it('highlights exactly the fields marked required:true in a synthetic schema, nothing else', async () => {
        const schema = [
            { key: 'a', label: 'Field A', required: false },
            { key: 'b', label: 'Field B', required: true },
            { key: 'c', label: 'Field C', required: false },
        ];
        const workbook = await buildXlsxTemplate(schema, [], {});
        expect(highlightedLabels(workbook, schema)).toEqual(['Field B']);
    });

    it('highlights nothing when no field is required', async () => {
        const schema = [
            { key: 'a', label: 'Field A', required: false },
            { key: 'b', label: 'Field B', required: false },
        ];
        const workbook = await buildXlsxTemplate(schema, [], {});
        expect(highlightedLabels(workbook, schema)).toEqual([]);
    });

    it('reacts to a schema change with no template-side code change — proves there is no separate hardcoded list', async () => {
        const schema = [{ key: 'x', label: 'X', required: true }];
        const before = highlightedLabels(await buildXlsxTemplate(schema, [], {}), schema);
        expect(before).toEqual(['X']);

        schema[0].required = false; // flip the schema, nothing else changes
        const after = highlightedLabels(await buildXlsxTemplate(schema, [], {}), schema);
        expect(after).toEqual([]);
    });

    // Phone-number-only-mandatory policy (see PhoneOnlyMandatoryPolicy.md):
    // exactly one field is required in each of Raw Data's and Delivery
    // Data's real, live schemas — Phone Number. If a future edit to either
    // schema accidentally marks a second field required (or un-marks Phone
    // Number), this fails without needing to download an actual template.
    it('Raw Data template: only Phone Number is highlighted required', async () => {
        const workbook = await buildXlsxTemplate(RAW_DATA_FIELDS, [], {});
        expect(highlightedLabels(workbook, RAW_DATA_FIELDS)).toEqual(['Phone Number']);
    });

    it('Delivery Data template: only Phone Number is highlighted required', async () => {
        const workbook = await buildXlsxTemplate(DELIVERY_DATA_FIELDS, [], {});
        expect(highlightedLabels(workbook, DELIVERY_DATA_FIELDS)).toEqual(['Phone Number']);
    });

    it('COS template: only Contact Number is highlighted required', async () => {
        const workbook = await buildXlsxTemplate(BASE_FIELDS_CALL, [], {});
        expect(highlightedLabels(workbook, BASE_FIELDS_CALL)).toEqual(['Contact Number']);
    });

    it('Positives template: only Contact Number is highlighted required', async () => {
        const workbook = await buildXlsxTemplate(BASE_FIELDS_POSITIVE, [], {});
        expect(highlightedLabels(workbook, BASE_FIELDS_POSITIVE)).toEqual(['Contact Number']);
    });
});

// Phone-number-only-mandatory policy, direct schema assertion (belt-and-
// braces alongside the template-highlighting checks above): guards the
// underlying data even if the template's visual styling logic ever changes.
describe('RAW_DATA_FIELDS / DELIVERY_DATA_FIELDS — exactly one required field', () => {
    it('Raw Data: only phoneNumber is required:true', () => {
        const required = RAW_DATA_FIELDS.filter(f => f.required).map(f => f.key);
        expect(required).toEqual(['phoneNumber']);
    });

    it('Delivery Data: only phoneNumber is required:true', () => {
        const required = DELIVERY_DATA_FIELDS.filter(f => f.required).map(f => f.key);
        expect(required).toEqual(['phoneNumber']);
    });

    it('COS: only phone is required:true', () => {
        const required = BASE_FIELDS_CALL.filter(f => f.required).map(f => f.key);
        expect(required).toEqual(['phone']);
    });

    it('Positives: only phone is required:true', () => {
        const required = BASE_FIELDS_POSITIVE.filter(f => f.required).map(f => f.key);
        expect(required).toEqual(['phone']);
    });
});
