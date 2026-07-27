import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFollowUps, createFollowUp, updateFollowUp, deleteFollowUp } from '../../../../server/src/controllers/followUps.js';
import { query } from '../../../../server/src/config/db.js';
import { mockRequest, mockResponse } from '../../../helpers/httpMocks.js';

vi.mock('../../../../server/src/config/db.js', () => ({
  query: vi.fn(),
  default: {
    query: vi.fn()
  }
}));

vi.mock('../../../../server/src/services/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(true),
  cacheDelete: vi.fn(),
  cacheDeletePattern: vi.fn(),
}));

describe('followUpsController.createFollowUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('schedules a follow up successfully', async () => {
    const mockFollowUp = { id: 'fu-1', description: 'Initial contact' };
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ sub_vertical_id: 'sv-1', vertical_id: 'vert-1', assigned_to: 'agent-1' }] }) // fetch lead
      .mockResolvedValueOnce({ rows: [mockFollowUp] }); // insert follow_up

    const req = mockRequest({
      user: { sub: 'admin-1', role: 'super_admin' },
      params: { leadId: 'lead-1' },
      body: {
        assignedToId: 'agent-1',
        followUpDate: '2026-06-20T10:00:00.000Z',
        description: 'Initial contact',
        status: 'PENDING'
      }
    });
    const res = mockResponse();

    await createFollowUp(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: mockFollowUp })
    );
  });
});

describe('followUpsController.getFollowUps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores invalid assignedTo query parameter and executes successfully', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ vertical_id: '00000000-0000-0000-0000-000000000001', assigned_to: 'agent-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const req = mockRequest({
      user: { sub: 'admin-1', role: 'super_admin' },
      params: { costConversionId: '00000000-0000-0000-0000-000000000002' },
      query: { assignedTo: 'invalid-uuid-string' }
    });
    const res = mockResponse();

    await getFollowUps(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const queryCalls = vi.mocked(query).mock.calls;
    expect(queryCalls[1][0]).not.toContain('AND f.assigned_to_id =');
  });

  it('filters by assignedTo when a valid UUID is provided', async () => {
    const validUuid = '00000000-0000-0000-0000-000000000003';
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ vertical_id: '00000000-0000-0000-0000-000000000001', assigned_to: 'agent-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const req = mockRequest({
      user: { sub: 'admin-1', role: 'super_admin' },
      params: { costConversionId: '00000000-0000-0000-0000-000000000002' },
      query: { assignedTo: validUuid }
    });
    const res = mockResponse();

    await getFollowUps(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const queryCalls = vi.mocked(query).mock.calls;
    expect(queryCalls[1][0]).toContain('f.assigned_to_id');
    expect(queryCalls[1][1]).toContain(validUuid);
  });
});
