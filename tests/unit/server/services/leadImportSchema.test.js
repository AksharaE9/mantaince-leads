import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateRowAgainstSchema, getLeadImportSchema } from '../../../../server/src/services/leadImportSchema.js';
import { query } from '../../../../server/src/config/db.js';

vi.mock('../../../../server/src/config/db.js', () => ({
  query: vi.fn(),
  default: { query: vi.fn() },
}));

vi.mock('../../../../server/src/services/cache.js', () => ({
  withCache: vi.fn((key, ttl, fn) => fn()),
}));

const SIMPLE_SCHEMA = [
  { key: 'businessName', label: 'Business Name', type: 'string', required: true, maxLength: 10 },
  { key: 'phone', label: 'Contact Number', type: 'phone', required: true },
  { key: 'email', label: 'Email', type: 'email', required: false },
  { key: 'source', label: 'Lead Source', type: 'enum', required: true, options: ['FB Ads', 'Referral'] },
  { key: 'notes', label: 'Notes', type: 'string', required: false },
];

describe('validateRowAgainstSchema', () => {
  it('returns no errors for a fully valid row', () => {
    const errors = validateRowAgainstSchema(
      { businessName: 'Acme', phone: '9876543210', email: 'a@b.com', source: 'FB Ads' },
      SIMPLE_SCHEMA
    );
    expect(errors).toEqual([]);
  });

  it('flags missing required fields', () => {
    const errors = validateRowAgainstSchema({ phone: '9876543210', source: 'FB Ads' }, SIMPLE_SCHEMA);
    expect(errors).toContainEqual({ field: 'businessName', message: 'Business Name is required' });
  });

  it('does not require optional fields', () => {
    const errors = validateRowAgainstSchema(
      { businessName: 'Acme', phone: '9876543210', source: 'FB Ads' },
      SIMPLE_SCHEMA
    );
    expect(errors).toEqual([]);
  });

  it('rejects an invalid phone number', () => {
    const errors = validateRowAgainstSchema(
      { businessName: 'Acme', phone: 'abc', source: 'FB Ads' },
      SIMPLE_SCHEMA
    );
    expect(errors).toContainEqual({ field: 'phone', message: 'Contact Number is not a valid phone number' });
  });

  it('rejects an invalid email format', () => {
    const errors = validateRowAgainstSchema(
      { businessName: 'Acme', phone: '9876543210', source: 'FB Ads', email: 'not-an-email' },
      SIMPLE_SCHEMA
    );
    expect(errors).toContainEqual({ field: 'email', message: 'Email is not a valid email address' });
  });

  it('rejects a value not in the enum option list', () => {
    const errors = validateRowAgainstSchema(
      { businessName: 'Acme', phone: '9876543210', source: 'Instagram' },
      SIMPLE_SCHEMA
    );
    expect(errors).toContainEqual({ field: 'source', message: '"Instagram" is not a valid Lead Source option' });
  });

  it('accepts enum values case-insensitively', () => {
    const errors = validateRowAgainstSchema(
      { businessName: 'Acme', phone: '9876543210', source: 'fb ads' },
      SIMPLE_SCHEMA
    );
    expect(errors).toEqual([]);
  });

  it('rejects a value exceeding maxLength', () => {
    const errors = validateRowAgainstSchema(
      { businessName: 'A Very Long Business Name', phone: '9876543210', source: 'FB Ads' },
      SIMPLE_SCHEMA
    );
    expect(errors).toContainEqual({ field: 'businessName', message: 'Business Name exceeds 10 characters' });
  });

  it('treats null/undefined the same as an empty string for required checks', () => {
    const errorsNull = validateRowAgainstSchema({ businessName: null, phone: '9876543210', source: 'FB Ads' }, SIMPLE_SCHEMA);
    const errorsUndefined = validateRowAgainstSchema({ phone: '9876543210', source: 'FB Ads' }, SIMPLE_SCHEMA);
    expect(errorsNull).toContainEqual({ field: 'businessName', message: 'Business Name is required' });
    expect(errorsUndefined).toContainEqual({ field: 'businessName', message: 'Business Name is required' });
  });
});

describe('getLeadImportSchema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges fixed base fields with active, CSV-mapped custom fields for the vertical', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [
        { field_key: 'budget', csv_header: 'BUDGET', label: 'Budget', field_type: 'select', options: ['Low', 'High'], is_required: true, is_csv_mapped: true, display_order: 1 },
      ],
    });

    const schema = await getLeadImportSchema('vertical-1', 'CALL');
    const baseKeys = schema.map((f) => f.key);

    expect(baseKeys).toContain('phone');
    expect(baseKeys).toContain('businessName');
    const custom = schema.find((f) => f.key === 'budget');
    expect(custom).toMatchObject({ type: 'enum', options: ['Low', 'High'], required: true, custom: true });
  });

  it('drops custom fields whose header collides with a base header', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [
        { field_key: 'dup', csv_header: 'CONTACT', label: 'Dup Phone', field_type: 'text', options: [], is_required: false, is_csv_mapped: true, display_order: 1 },
      ],
    });

    const schema = await getLeadImportSchema('vertical-1', 'CALL');
    const dup = schema.find((f) => f.key === 'dup');
    expect(dup).toBeUndefined();
  });

  it('excludes custom fields not flagged is_csv_mapped', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [
        { field_key: 'internal', csv_header: 'INTERNAL', label: 'Internal', field_type: 'text', options: [], is_required: false, is_csv_mapped: false, display_order: 1 },
      ],
    });

    const schema = await getLeadImportSchema('vertical-1', 'CALL');
    expect(schema.find((f) => f.key === 'internal')).toBeUndefined();
  });

  it('uses the POSITIVE field set when leadType is POSITIVE', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    const schema = await getLeadImportSchema('vertical-1', 'POSITIVE');
    const keys = schema.map((f) => f.key);
    expect(keys).toContain('followUpRequired');
    expect(keys).not.toContain('appointmentType');
  });
});
