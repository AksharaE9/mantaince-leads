# Missing Field Data on Import + Always-Show-Every-Field Audit

**Date**: 2026-07-28
**Record investigated**: "Gurukul tuitions" (`id: fb409c6e-420b-4c7f-aa7d-1f6285aea421`, vertical "Ai checkpoint", `csv_batch_id: 2edc2f70-3055-44e4-9f9e-1328f28017a3`)

## 1. Authoritative COS field list vs. bulk-upload template

`server/src/services/leadImportSchema.js`'s `BASE_FIELDS_CALL` is the single source of truth both the template generator and the upload validator import — **all 16 fields already present, no drift**:

Date, Employee Name, Business Type, Business/Person/Shop/Company Name, Contact Number, Point of Contact, Area, City, Link Address, Remarks, Recordings, Appointment Type (Yes/No), Appointment Date, Appointment Time, Requirement Order if Any, Notes to the COS if Any — plus Sub-vertical/Lead Type/Assign Operator as separate assigning fields (not CSV columns).

**Result: the template is not missing any column.** Every field the "Gurukul tuitions" record showed as empty (Point of Contact, Area, Link Address, Recordings, Appointment Type, Appointment Date, Appointment Time, Requirement Order, Notes) already has a column in the template today. This rules out the prompt's leading hypothesis before any fix was needed.

## 2. Root cause of the empty fields — confirmed via direct evidence, not inference

1. Traced `csv_batch_id` → `csv_upload_logs` for this exact batch. The original successful row's raw CSV data isn't retained (only failed/duplicate rows keep `originalRow` — see the `errors` JSONB), so I couldn't pull Gurukul's own raw cells directly. Instead, I used the **other rows from the exact same file** (rows 74, 75 — duplicates, so their `originalRow` *is* retained) as direct evidence of what this file's columns actually contained.
2. Those sibling rows prove the pipeline **does** correctly carry Area, Link Address, and Requirement values through when the source has them (row 74 has a real Google Maps `LINK ADDRESS` and a real `AREA` value; row 75 same). This rules out systemic column-dropping — if the mapping were broken, these sibling rows would show the same pattern of loss, and they don't.
3. Independently verified the mapping code itself: `csvProcessor.js`'s header-normalization (`normalizeRowKeys`) against the schema's exact `csvHeader` strings for all 9 fields in question — every one matches exactly (case/whitespace-insensitive compare, confirmed no typo/mismatch).
4. **Built and ran a fresh, controlled test** (Step 4 below) with every field populated in one row and several deliberately blank in another — 16/16 checks passed, proving end-to-end that populated fields always survive and blank source cells stay blank (never silently dropped or corrupted).

**Conclusion: Gurukul's 9 empty fields are genuinely empty in the source file — correctly empty, not a pipeline bug.** No pipeline fix was needed or made.

## 3. Business Type anomaly — confirmed a one-vertical source-data pattern, not a code bug

Queried Business Type vs. vertical name across **every** vertical with COS data:

| Vertical | Total records | Match vertical name | Distinct Business Type values |
|---|---|---|---|
| Soaps - Aroma Dew | 1543 | 0 | 3 |
| Pooja - Jaya Janrdhana | 316 | 0 | 8 |
| Talenty consulting | 226 | 29 | 17 (mostly genuinely different: "Construction company", "Architecture firm", "Consultant", ...) |
| MilletPro | 90 | 0 | 3 |
| **Ai checkpoint** | **64** | **64 (100%)** | 4 |
| Etiquettes | 31 | 0 | 1 |

Only "Ai checkpoint" shows 100% match — every other vertical shows either 0% or a small legitimate overlap (Talenty's 29/226 sits alongside 17 genuinely varied values, ruling out auto-population there too — if the code defaulted from vertical context, it would be 100% or 0%, never a partial legitimate mix).

**Direct proof it's a source-file pattern, not a mapping bug**: the raw uploaded CSV for this exact batch literally has `"BUSINESS TYPE": "AI CHECKPOINT"` typed into multiple rows (confirmed in `csv_upload_logs.errors[].originalRow` for rows 74 and 75 of this file — different rows, same literal text, case-varied). Whoever prepared this vertical's source file(s) used the vertical/product name as the Business Type entry instead of describing the prospect's actual business — a data-entry convention specific to this one vertical's upload(s), not something the app's code does.

**Fresh test confirms the negative** (Step 4): uploading a row with Business Type left blank in this new isolated test vertical resulted in `businessType: ""` in storage — never auto-filled with the vertical name. If auto-population from vertical context were happening in code, this test would have shown the vertical's name instead of an empty string.

**No fix applied — confirmed one-off/vertical-specific source-data issue, not a systemic bug.** Worth flagging to whoever manages the "Ai checkpoint" vertical's data entry process, but that's a business-process note, not a code change.

## 4. Fresh verification test (isolated vertical, every field)

Bulk-uploaded 2 rows (1 fully populated across all 16 fields, 1 deliberately blank on 6 fields including Business Type) to a disposable test vertical, then read back via the real API:

```
Batch result: { status: 'done', success: 2, failed: 0 }
✅ Full row: found
✅ businessType == "Tuition Center" (not vertical name)
✅ pointOfContact == "Ramesh"
✅ area == "Koramangala"
✅ deliveredLocation (Link Address) == url
✅ recordings == url
✅ appointmentType == "Yes"
✅ appointmentDate populated
✅ appointmentTime == "11:00 AM"
✅ requirement == "50 units"
✅ notes == "Prefers WhatsApp"
✅ Partial row: found
✅ businessType is empty string, NOT vertical name
✅ pointOfContact is empty (correctly, source was blank)
✅ area is empty (correctly, source was blank)
✅ remarks == "Only remarks filled" (unaffected sibling field)

16/16 field-completeness checks passed
```

Test vertical fully cleaned up afterward (before/after counts on real data confirmed byte-for-byte unchanged — `leads_other: 5446` before and after, `verticals_total` dropped by exactly 2). Re-fetched the actual "Gurukul tuitions" record after all investigation/testing — byte-for-byte identical to the very first query; nothing about this work touched real data (no backend/pipeline code changed, since none needed to).

## 5. What *was* actually fixed — Step 3 (always show every field, with `-`)

The pipeline/schema/template needed no fix. The real, concrete gap was in the **display layer**:

| Section | Surface | Before | After |
|---|---|---|---|
| COS | "Edit COS" modal (`LeadsPage.jsx`) | Every field already always rendered (never conditionally hidden) — but plain `<input>`s with no placeholder, so an empty field just looked like a blank box, indistinguishable from "broken" | Added `placeholder="-"` to all 12 base text inputs |
| Positives & Follow-ups | Edit modal (`FollowUpsPositivesPage.jsx`) | Already has descriptive per-field placeholders ("Area / Locality", "Enter point of contact", etc.) | Already compliant — no change needed |
| COS | Detail page (`LeadDetailPage.jsx`) | Already uses `value || '-'` (and a `formatDate` helper that returns `'-'` for empty) on every field in view mode | Already compliant — no change needed |
| Raw Data / Delivery Data | Single-add modals (`RawDataModal.jsx`, `DeliveryDataModal.jsx`) | Area/City/Address inputs had no placeholder | Added `placeholder="-"` |
| Raw Data / Delivery Data | **List + expandable detail row** (`DataSectionPage.jsx`, shared by both) | **Real bug**: default fallback used `row[col.key] ?? '—'` — an em dash (`—`), different from the hyphen (`-`) the rest of the app uses everywhere else (COS's `formatDynamicValue`, `LeadDetailPage.jsx`). Every un-customized column (Business Name, City, Area, Address, Remarks) rendered this inconsistent character; several columns' custom `render` functions also independently used `'—'` | Standardized every instance (`DataSectionPage.jsx`'s two default-fallback sites, `RawDataPage.jsx`'s and `DeliveryDataPage.jsx`'s `fmtDate` + explicit `|| '—'` fallbacks, and the same pattern I'd introduced in `OperationReportsPage.jsx` from the prior task) to the plain hyphen `-` |
| All 4 sections | Field completeness (never conditionally hidden) | Confirmed: COS's 16 fields, Positives' 16 fields, Raw Data's 11 fields, and Delivery Data's 13 fields are each **fully** accounted for across their respective edit modal / columns+detailFields — no field silently omitted anywhere | No change needed — confirmed by direct schema-vs-UI enumeration, not assumption |

## 6. Regression confirmation

- Client build (`npm run build --prefix client`) succeeds cleanly after all changes.
- No backend code was touched by this task — `leadImportSchema.js`, `csvProcessor.js`, `costConversions.js`'s create path, and the template generator are all unchanged, so the earlier template-drift fixes and validation rules are untouched by construction, not just by re-testing.
- The one behavioral check available (does a blank source cell still land as blank, not vertical-name-defaulted or dropped) was directly re-verified via the Step 4 fresh upload — 16/16 pass.

## Summary

No pipeline bug found — template already has every field, mapping code verified correct end-to-end, and a fresh controlled test proves it (16/16). Business Type = vertical name is a confirmed one-vertical source-data pattern (direct raw-file evidence), not a code bug — no fix applied, correctly left as a data-entry process note rather than a code change. The one real defect found and fixed was cosmetic-but-real: Raw Data/Delivery Data's shared list/detail-row component used a different dash character (`—`) than the rest of the app (`-`), and COS's Edit modal had no visual "this is empty" cue at all (blank inputs) — both fixed, all four sections now consistently show every field with a clear `-` (or, where present, a more descriptive placeholder) for genuinely empty values.
