import { connectDB, query } from '../config/db.js';
import crypto from 'crypto';

const ALLOWED_VERTICALS = [
    'real-estate',
    'milletpro',
    'pooja-jaya-janrdhana',
    'soaps-aroma-dew',
    'erp-saas',
    'competitions',
    'ace-it-up',
    'etiquettes'
];

const ALLOWED_SUB_VERTICALS = {
    'real-estate': ['Standard'],
    'milletpro': ['Specific Affiliates'],
    'pooja-jaya-janrdhana': ['Specific Affiliate', 'Wholesaler, Distributors', 'Retail Shops', 'To Businesses'],
    'soaps-aroma-dew': ['Hotels, Resorts'],
    'erp-saas': ['Standard'],
    'competitions': ['Standard'],
    'ace-it-up': ['Standard'],
    'etiquettes': ['Standard']
};

const generateSlug = (name) => {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
};

async function cleanup() {
    try {
        await connectDB();
        console.log('🧹 Starting cleanup of database taxonomy...');

        // 1. Delete all verticals not in the allowed list (will cascade delete sub-verticals, leads, etc.)
        const placeHolders = ALLOWED_VERTICALS.map((_, i) => `$${i + 1}`).join(', ');
        const deleteVertsRes = await query(`
            DELETE FROM verticals 
            WHERE slug NOT IN (${placeHolders})
            RETURNING name, slug
        `, ALLOWED_VERTICALS);

        console.log(`❌ Deleted ${deleteVertsRes.rowCount} dummy vertical(s):`);
        deleteVertsRes.rows.forEach(v => console.log(`   - ${v.name} (${v.slug})`));

        // 2. Fetch the remaining real verticals to verify and cleanup their sub-verticals
        const verticalsRes = await query('SELECT id, name, slug FROM verticals');
        const adminRes = await query("SELECT id FROM users WHERE email = 'adminofleads@gmail.com'");
        const adminId = adminRes.rows[0]?.id || null;

        for (const v of verticalsRes.rows) {
            const allowedSubs = ALLOWED_SUB_VERTICALS[v.slug] || [];
            
            // Check if we need to seed the default 'Standard' sub-vertical for Real Estate or others if empty
            if (allowedSubs.length > 0) {
                for (const subName of allowedSubs) {
                    const subSlug = generateSlug(subName);
                    const subCheck = await query('SELECT id FROM sub_verticals WHERE vertical_id = $1 AND slug = $2', [v.id, subSlug]);
                    if (subCheck.rows.length === 0) {
                        const subId = crypto.randomUUID();
                        await query(`
                            INSERT INTO sub_verticals (id, name, slug, vertical_id, display_order, created_by)
                            VALUES ($1, $2, $3, $4, 1, $5)
                        `, [subId, subName, subSlug, v.id, adminId]);
                        console.log(`🌱 Created missing sub-vertical "${subName}" for vertical "${v.name}"`);
                    }
                }
            }

            // Delete sub-verticals not in the allowed list for this vertical
            const allowedSlugs = allowedSubs.map(generateSlug);
            if (allowedSlugs.length > 0) {
                const subPlaceholders = allowedSlugs.map((_, i) => `$${i + 2}`).join(', ');
                const deleteSubsRes = await query(`
                    DELETE FROM sub_verticals
                    WHERE vertical_id = $1 AND slug NOT IN (${subPlaceholders})
                    RETURNING name, slug
                `, [v.id, ...allowedSlugs]);

                if (deleteSubsRes.rowCount > 0) {
                    console.log(`❌ Deleted ${deleteSubsRes.rowCount} dummy sub-vertical(s) from vertical "${v.name}":`);
                    deleteSubsRes.rows.forEach(s => console.log(`   - ${s.name} (${s.slug})`));
                }
            } else {
                // If no sub-verticals allowed, delete all
                const deleteSubsRes = await query('DELETE FROM sub_verticals WHERE vertical_id = $1 RETURNING name', [v.id]);
                if (deleteSubsRes.rowCount > 0) {
                    console.log(`❌ Deleted all ${deleteSubsRes.rowCount} sub-verticals from vertical "${v.name}"`);
                }
            }
        }

        // 3. Delete any orphaned leads where sub_vertical_id is NULL or not in sub_verticals table
        const deleteOrphansRes = await query(`
            DELETE FROM cost_conversions 
            WHERE sub_vertical_id IS NULL OR sub_vertical_id NOT IN (SELECT id FROM sub_verticals)
            RETURNING id, name, business_name
        `);
        if (deleteOrphansRes.rowCount > 0) {
            console.log(`❌ Deleted ${deleteOrphansRes.rowCount} orphaned/dummy lead(s) with no valid sub-vertical.`);
        }

        // 4. Refresh taxonomy cache
        await query('SELECT refresh_mv_vertical_tree()').catch(() => {});
        console.log('✅ Database taxonomy cleanup completed successfully!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Database cleanup failed:', err);
        process.exit(1);
    }
}

cleanup();
