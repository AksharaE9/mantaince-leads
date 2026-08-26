/**
 * Interaction log import field definitions.
 *
 * These are consumed by two distinct contexts:
 *
 * 1. FOLLOWUP_APPEND_FIELDS — appended to the main COS/Positives lead import
 *    template as 5 optional trailing columns. Users filling out a standard
 *    lead upload can optionally add an initial interaction entry inline.
 *    All 5 fields are optional (required: false). If all 5 are blank, the
 *    row produces no interaction log entry (silent skip, not an error).
 *
 * 2. FOLLOWUP_ONLY_FIELDS — the dedicated "Add Follow-up Log" template.
 *    Phone is required (needed to match an existing lead). All 5
 *    interaction fields remain optional individually, but the row must
 *    have at least one non-blank interaction field to be useful; rows
 *    that are completely empty produce no entry.
 *
 * Valid outcomes enum is defined here as the single source of truth so
 * it's automatically applied to the XLSX dropdown validator in the template
 * builder AND enforced at the controller level.
 */

export const INTERACTION_OUTCOMES = [
    'Interested',
    'Not Reachable',
    'Callback Requested',
    'Not Interested',
    'Converted',
];

/**
 * The 5 optional follow-up columns appended to main COS/Positives templates.
 * Field keys match what csvProcessor.js reads in the data-payload step.
 */
export const FOLLOWUP_APPEND_FIELDS = [
    {
        key: 'followupDate',
        label: 'Follow-up Date',
        csvHeader: 'Follow-up Date',
        type: 'date',
        required: false,
        placeholder: '24-07-2026',
        helpText: 'Date of this interaction (DD-MM-YYYY)',
    },
    {
        key: 'followupTime',
        label: 'Follow-up Time',
        csvHeader: 'Follow-up Time',
        type: 'string',
        required: false,
        placeholder: '10:00 AM',
        helpText: 'Time or time-range (free text)',
    },
    {
        key: 'followupRemarks',
        label: 'Follow-up Remarks',
        csvHeader: 'Follow-up Remarks',
        type: 'string',
        required: false,
        placeholder: 'Spoke for 5 min, interested in 50 units',
        helpText: 'Notes from this interaction',
    },
    {
        key: 'followupOutcome',
        label: 'Follow-up Outcome',
        csvHeader: 'Follow-up Outcome',
        type: 'enum',
        required: false,
        options: INTERACTION_OUTCOMES,
        helpText: 'Select an outcome for this interaction',
    },
    {
        key: 'nextFollowupDate',
        label: 'Next Follow-up Date',
        csvHeader: 'Next Follow-up Date',
        type: 'date',
        required: false,
        placeholder: '01-08-2026',
        helpText: 'Planned date for the next follow-up (DD-MM-YYYY)',
    },
];

/**
 * Dedicated follow-ups-only template field list.
 * Phone number (to match existing lead) + the 5 interaction fields.
 */
export const FOLLOWUP_ONLY_FIELDS = [
    {
        key: 'phone',
        label: 'Contact Number',
        csvHeader: 'Contact Number',
        type: 'phone',
        required: true,
        placeholder: '9876543210',
        helpText: 'Must match a contact number already in this section',
    },
    ...FOLLOWUP_APPEND_FIELDS,
];

/**
 * Returns true if a normalized row object has at least one non-blank
 * follow-up field. Used by csvProcessor.js to decide whether a given
 * CSV row should produce an interaction log entry (or be silently skipped).
 */
export function hasFollowupData(row) {
    return !!(
        (row['follow-up date'] || row['followup date'] || row['follow up date'] || row['followupDate']) ||
        (row['follow-up time'] || row['followup time'] || row['follow up time'] || row['followupTime']) ||
        (row['follow-up remarks'] || row['followup remarks'] || row['follow up remarks'] || row['followupRemarks']) ||
        (row['follow-up outcome'] || row['followup outcome'] || row['follow up outcome'] || row['followupOutcome']) ||
        (row['next follow-up date'] || row['next followup date'] || row['next follow up date'] || row['nextFollowupDate'])
    );
}

/**
 * Extracts follow-up fields from a normalized row object.
 * Returns null if no follow-up data is present (all blank).
 */
export function extractFollowupFields(row) {
    const interactionDate =
        row['follow-up date'] || row['followup date'] || row['follow up date'] || row['followupDate'] || '';
    const interactionTime =
        row['follow-up time'] || row['followup time'] || row['follow up time'] || row['followupTime'] || '';
    const remarks =
        row['follow-up remarks'] || row['followup remarks'] || row['follow up remarks'] || row['followupRemarks'] || '';
    const outcome =
        row['follow-up outcome'] || row['followup outcome'] || row['follow up outcome'] || row['followupOutcome'] || '';
    const nextFollowupDate =
        row['next follow-up date'] || row['next followup date'] || row['next follow up date'] || row['nextFollowupDate'] || '';

    if (!interactionDate && !interactionTime && !remarks && !outcome && !nextFollowupDate) {
        return null; // no follow-up data on this row
    }

    return { interactionDate, interactionTime, remarks, outcome, nextFollowupDate };
}
