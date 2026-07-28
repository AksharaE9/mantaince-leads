import { query } from '../config/db.js';
import crypto from 'crypto';
import { logAudit } from '../services/audit.js';
import { isValidUUID } from '../utils/validators/index.js';
import {
    withCache, cacheGet, cacheSet, cacheDelete,
    invalidateOnTaxonomyChange
} from '../services/cache.js';
import { CacheKeys, TTL } from '../lib/cacheKeys.js';
import { broadcastToAll } from '../services/assignmentBroadcaster.js';

/**
 * Generate standard slug from name
 */
const generateSlug = (name) => {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
};

// ── Vertical Controllers ───────────────────────────────────────────────────────

/**
 * GET /verticals
 * Cached for 24h. Non-super_admin users get a filtered subset
 * (RBAC filtering happens in-memory from the cached full list).
 */
export const getVerticals = async (req, res) => {
    try {
        const verticals = await withCache(CacheKeys.verticals(), TTL.VERTICALS, async () => {
            const vertRes = await query('SELECT * FROM verticals ORDER BY display_order ASC');
            return vertRes.rows;
        });



        return res.status(200).json({ success: true, data: verticals });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * POST /verticals
 */
export const createVertical = async (req, res) => {
    const { name, description, color, icon, statuses } = req.body;
    try {
        const slug = generateSlug(name);

        // Parallelize slug-exists check and MAX display_order lookup
        const [existsRes, maxOrderRes] = await Promise.all([
            query('SELECT id FROM verticals WHERE slug = $1', [slug]),
            query('SELECT COALESCE(MAX(display_order), 0) AS max FROM verticals'),
        ]);

        if (existsRes.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'A vertical with this name slug already exists' });
        }

        const defaultStatuses = [
            { value: 'new', label: 'New' },
            { value: 'contacted', label: 'Contacted' },
            { value: 'qualified', label: 'Qualified' },
            { value: 'visit_scheduled', label: 'Meeting Scheduled' },
            { value: 'visit_completed', label: 'Meeting Completed' },
            { value: 'negotiation', label: 'Negotiation' },
            { value: 'converted', label: 'Converted' },
            { value: 'lost', label: 'Lost' },
            { value: 'invalid', label: 'Invalid' },
        ];

        const displayOrder = parseInt(maxOrderRes.rows[0].max, 10) + 1;
        const verticalId   = crypto.randomUUID();
        const verticalRes  = await query(`
            INSERT INTO verticals (id, name, slug, description, color, icon, display_order, created_by, statuses)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `, [verticalId, name, slug, description || '', color || '#185FA5', icon || 'Layers', displayOrder, req.user.sub, JSON.stringify(statuses || defaultStatuses)]);

        const vertical = verticalRes.rows[0];

        // Invalidate taxonomy caches
        await invalidateOnTaxonomyChange(null);
        await broadcastToAll({ type: 'VERTICAL_MUTATED' });

        logAudit(req, { action: 'vertical.create', targetCollection: 'verticals', targetId: vertical.id, after: vertical });

        return res.status(201).json({ success: true, data: vertical });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * GET /verticals/:id
 * Returns vertical + embedded sub-verticals. Both are cached together.
 */
export const getVerticalById = async (req, res) => {
    const { id } = req.params;
    if (!isValidUUID(id)) {
        return res.status(404).json({ success: false, error: 'Vertical not found' });
    }
    try {
        const cacheKey = CacheKeys.verticalFull(id);
        const result   = await withCache(cacheKey, TTL.VERTICALS, async () => {
            // Parallel fetch of vertical + its sub-verticals — one round-trip each
            const [vertRes, subRes] = await Promise.all([
                query('SELECT * FROM verticals WHERE id = $1', [id]),
                query('SELECT * FROM sub_verticals WHERE vertical_id = $1 ORDER BY display_order ASC', [id]),
            ]);
            const vertical = vertRes.rows[0];
            if (!vertical) return null;
            return { ...vertical, subVerticals: subRes.rows };
        });

        if (!result) {
            return res.status(404).json({ success: false, error: 'Vertical not found' });
        }

        return res.status(200).json({ success: true, data: result });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * PATCH /verticals/:id
 */
export const updateVertical = async (req, res) => {
    const { id } = req.params;
    const { name, description, color, icon, isActive, statuses } = req.body;
    try {
        const verticalRes = await query('SELECT * FROM verticals WHERE id = $1', [id]);
        const vertical    = verticalRes.rows[0];
        if (!vertical) {
            return res.status(404).json({ success: false, error: 'Vertical not found' });
        }

        const before     = { ...vertical };
        const setClauses = [];
        const params     = [id];
        let   pIdx       = 2;

        if (name) {
            setClauses.push(`name = $${pIdx++}`, `slug = $${pIdx++}`);
            params.push(name, generateSlug(name));
        }
        if (description !== undefined) { setClauses.push(`description = $${pIdx++}`); params.push(description); }
        if (color)                      { setClauses.push(`color = $${pIdx++}`);       params.push(color); }
        if (icon)                       { setClauses.push(`icon = $${pIdx++}`);        params.push(icon); }
        if (isActive !== undefined)     { setClauses.push(`is_active = $${pIdx++}`);   params.push(isActive); }
        if (statuses !== undefined)     { setClauses.push(`statuses = $${pIdx++}`);    params.push(JSON.stringify(statuses)); }

        if (setClauses.length === 0) {
            return res.status(200).json({ success: true, data: vertical });
        }

        const updatedRes     = await query(
            `UPDATE verticals SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
            params
        );
        const updatedVertical = updatedRes.rows[0];

        await invalidateOnTaxonomyChange(id);
        await broadcastToAll({ type: 'VERTICAL_MUTATED' });

        logAudit(req, { action: 'vertical.update', targetCollection: 'verticals', targetId: id, before, after: updatedVertical });

        return res.status(200).json({ success: true, data: updatedVertical });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * DELETE /verticals/:id
 */
export const deleteVertical = async (req, res) => {
    const { id } = req.params;
    try {
        // First check for active leads linked to the vertical
        const leadsRes = await query('SELECT COUNT(*) FROM cost_conversions WHERE vertical_id = $1 AND is_deleted = false', [id]);

        if (parseInt(leadsRes.rows[0].count, 10) > 0) {
            return res.status(409).json({ success: false, error: 'Cannot delete vertical. Active Cost/Conversions are linked to it.' });
        }

        // Only delete if no active leads are linked
        const verticalRes = await query('DELETE FROM verticals WHERE id = $1 RETURNING *', [id]);
        const vertical = verticalRes.rows[0];
        if (!vertical) {
            return res.status(404).json({ success: false, error: 'Vertical not found' });
        }

        await invalidateOnTaxonomyChange(id);
        await broadcastToAll({ type: 'VERTICAL_MUTATED' });

        logAudit(req, { action: 'vertical.delete', targetCollection: 'verticals', targetId: id, before: vertical });

        return res.status(200).json({ success: true, data: { message: 'Vertical deleted successfully' } });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * PATCH /verticals/reorder
 *
 * Previous: serial for-loop — N individual UPDATE statements.
 * Now: single bulk UPDATE via VALUES ... AS t(id, order) — one round-trip.
 */
export const reorderVerticals = async (req, res) => {
    const items = req.body;
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: 'Invalid reorder list' });
    }

    try {
        // Build: UPDATE verticals SET display_order = t.order
        //        FROM (VALUES ($1,$2::int), ($3,$4::int), ...) AS t(id, ord)
        //        WHERE verticals.id = t.id::uuid
        const params = [];
        const tuples = items.map((item, i) => {
            params.push(item.id, item.displayOrder);
            return `($${params.length - 1}, $${params.length}::int)`;
        });

        await query(`
            UPDATE verticals AS v
            SET display_order = t.ord, updated_at = NOW()
            FROM (VALUES ${tuples.join(', ')}) AS t(id, ord)
            WHERE v.id = t.id::uuid
        `, params);

        await invalidateOnTaxonomyChange(null);
        await broadcastToAll({ type: 'VERTICAL_MUTATED' });

        await logAudit(req, {
            action: 'vertical.reorder',
            targetCollection: 'verticals',
            targetId: null,
            after: items
        });

        return res.status(200).json({ success: true, data: { message: 'Order updated' } });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

// ── Sub-Vertical Controllers ───────────────────────────────────────────────────

/**
 * GET /verticals/:verticalId/sub-verticals
 */
export const getSubVerticals = async (req, res) => {
    const { verticalId } = req.params;
    if (!isValidUUID(verticalId)) {
        return res.status(200).json({ success: true, data: [] });
    }
    try {
        const subVerticals = await withCache(CacheKeys.subVerticals(verticalId), TTL.SUB_VERTICALS, async () => {
            const res2 = await query(
                'SELECT * FROM sub_verticals WHERE vertical_id = $1 ORDER BY display_order ASC',
                [verticalId]
            );
            return res2.rows;
        });

        return res.status(200).json({ success: true, data: subVerticals });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * POST /verticals/:verticalId/sub-verticals
 */
export const createSubVertical = async (req, res) => {
    const { verticalId } = req.params;
    const { name }       = req.body;
    if (!isValidUUID(verticalId)) {
        return res.status(400).json({ success: false, error: 'Invalid vertical ID format' });
    }
    try {
        const slug = generateSlug(name);

        const [existsRes, maxOrderRes] = await Promise.all([
            query('SELECT id FROM sub_verticals WHERE vertical_id = $1 AND slug = $2', [verticalId, slug]),
            query('SELECT COALESCE(MAX(display_order), 0) AS max FROM sub_verticals WHERE vertical_id = $1', [verticalId])
        ]);

        if (existsRes.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'A sub-vertical with this name slug already exists in this vertical' });
        }

        const displayOrder = parseInt(maxOrderRes.rows[0].max, 10) + 1;

        const subId  = crypto.randomUUID();
        const subRes = await query(`
            INSERT INTO sub_verticals (id, name, slug, vertical_id, display_order, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `, [subId, name, slug, verticalId, displayOrder, req.user.sub]);

        await invalidateOnTaxonomyChange(verticalId);
        await broadcastToAll({ type: 'VERTICAL_MUTATED' });

        logAudit(req, { action: 'sub_vertical.create', targetCollection: 'sub_verticals', targetId: subId, after: subRes.rows[0] });

        return res.status(201).json({ success: true, data: subRes.rows[0] });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * PATCH /verticals/:verticalId/sub-verticals/:subId
 */
export const updateSubVertical = async (req, res) => {
    const { subId }      = req.params;
    const { name, isActive } = req.body;
    try {
        const subResCheck = await query('SELECT * FROM sub_verticals WHERE id = $1', [subId]);
        const subVertical = subResCheck.rows[0];
        if (!subVertical) {
            return res.status(404).json({ success: false, error: 'Sub-vertical not found' });
        }

        const setClauses = [];
        const params     = [subId];
        let   pIdx       = 2;

        if (name)               { setClauses.push(`name = $${pIdx++}`, `slug = $${pIdx++}`); params.push(name, generateSlug(name)); }
        if (isActive !== undefined) { setClauses.push(`is_active = $${pIdx++}`); params.push(isActive); }

        const sql = `UPDATE sub_verticals SET updated_at = NOW()${setClauses.length ? ', ' + setClauses.join(', ') : ''} WHERE id = $1 RETURNING *`;
        const updatedRes = await query(sql, params);

        if (updatedRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Sub-vertical not found' });
        }

        await invalidateOnTaxonomyChange(subVertical.vertical_id);
        await broadcastToAll({ type: 'VERTICAL_MUTATED' });

        logAudit(req, { action: 'sub_vertical.update', targetCollection: 'sub_verticals', targetId: subId, after: updatedRes.rows[0] });

        return res.status(200).json({ success: true, data: updatedRes.rows[0] });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * DELETE /verticals/:verticalId/sub-verticals/:subId
 */
export const deleteSubVertical = async (req, res) => {
    const { subId } = req.params;
    try {
        const subResCheck = await query('SELECT * FROM sub_verticals WHERE id = $1', [subId]);
        const subVertical = subResCheck.rows[0];
        if (!subVertical) {
            return res.status(404).json({ success: false, error: 'Sub-vertical not found' });
        }

        const leadsRes = await query(
            'SELECT COUNT(*) FROM cost_conversions WHERE sub_vertical_id = $1 AND is_deleted = false', [subId]
        );
        if (parseInt(leadsRes.rows[0].count, 10) > 0) {
            return res.status(409).json({ success: false, error: 'Active Cost/Conversions are linked to this sub-vertical' });
        }

        const subRes = await query('DELETE FROM sub_verticals WHERE id = $1 RETURNING *', [subId]);
        if (subRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Sub-vertical not found' });
        }

        await invalidateOnTaxonomyChange(subVertical.vertical_id);
        await broadcastToAll({ type: 'VERTICAL_MUTATED' });

        logAudit(req, { action: 'sub_vertical.delete', targetCollection: 'sub_verticals', targetId: subId, before: subRes.rows[0] });

        return res.status(200).json({ success: true, data: { message: 'Sub-vertical deleted successfully' } });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * PATCH /verticals/:verticalId/sub-verticals/reorder
 * Single bulk UPDATE — replaces serial for-loop.
 */
export const reorderSubVerticals = async (req, res) => {
    const { verticalId } = req.params;
    const items          = req.body;
    if (!isValidUUID(verticalId)) {
        return res.status(400).json({ success: false, error: 'Invalid vertical ID format' });
    }
    try {
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(200).json({ success: true, data: { message: 'Order updated' } });
        }

        const params = [];
        const tuples = items.map((item) => {
            params.push(item.id, item.displayOrder);
            return `($${params.length - 1}, $${params.length}::int)`;
        });

        await query(`
            UPDATE sub_verticals AS sv
            SET display_order = t.ord, updated_at = NOW()
            FROM (VALUES ${tuples.join(', ')}) AS t(id, ord)
            WHERE sv.id = t.id::uuid
        `, params);

        await invalidateOnTaxonomyChange(verticalId);
        await broadcastToAll({ type: 'VERTICAL_MUTATED' });

        await logAudit(req, {
            action: 'sub_vertical.reorder',
            targetCollection: 'sub_verticals',
            targetId: verticalId,
            after: items
        });

        return res.status(200).json({ success: true, data: { message: 'Order updated' } });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * GET /verticals/sub-verticals/:subId
 */
export const getSubVerticalById = async (req, res) => {
    const { subId } = req.params;
    if (!isValidUUID(subId)) {
        return res.status(404).json({ success: false, error: 'Sub-vertical not found' });
    }
    try {
        const cacheKey = `sub_vertical:single:${subId}`;
        const sub = await withCache(cacheKey, TTL.SUB_VERTICALS, async () => {
            const result = await query('SELECT * FROM sub_verticals WHERE id = $1', [subId]);
            return result.rows[0] || null;
        });

        if (!sub) {
            return res.status(404).json({ success: false, error: 'Sub-vertical not found' });
        }

        return res.status(200).json({ success: true, data: sub });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};
