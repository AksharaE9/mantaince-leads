import { query } from '../config/db.js';
import crypto from 'crypto';

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

const verticalsToRestore = [
    {
        name: 'Ai checkpoint',
        slug: 'ai-checkpoint',
        description: 'Ai checkpoint Vertical',
        color: '#9C27B0', // Purple
        icon: 'Cpu',
        subVerticals: ['Standard']
    },
    {
        name: 'Talenty consulting',
        slug: 'talenty-consulting',
        description: 'Talenty consulting Vertical',
        color: '#3F51B5', // Indigo
        icon: 'Users',
        subVerticals: ['Standard']
    }
];

async function restore() {
    try {
        console.log('🔄 Re-creating deleted vertical structures in database...');

        const adminRes = await query("SELECT id FROM users WHERE email = 'adminofleads@gmail.com'");
        const adminId = adminRes.rows[0]?.id || null;
        if (!adminId) {
            console.error('❌ Admin user not found.');
            process.exit(1);
        }

        const maxOrderRes = await query('SELECT COALESCE(MAX(display_order), 0) AS max FROM verticals');
        let nextDisplayOrder = parseInt(maxOrderRes.rows[0].max, 10) + 1;

        for (const v of verticalsToRestore) {
            // Check if vertical already exists
            const vertCheck = await query('SELECT id FROM verticals WHERE slug = $1', [v.slug]);
            let verticalId;

            if (vertCheck.rows.length > 0) {
                verticalId = vertCheck.rows[0].id;
                console.log(`ℹ️ Vertical "${v.name}" already exists.`);
            } else {
                verticalId = crypto.randomUUID();
                await query(`
                    INSERT INTO verticals (id, name, slug, description, color, icon, display_order, created_by, statuses)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                `, [
                    verticalId, v.name, v.slug, v.description, v.color, v.icon,
                    nextDisplayOrder++, adminId, JSON.stringify(defaultStatuses)
                ]);
                console.log(`✅ Created Vertical: "${v.name}"`);
            }

            // Create sub-verticals
            let subOrder = 1;
            for (const svName of v.subVerticals) {
                const svSlug = svName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                const subCheck = await query('SELECT id FROM sub_verticals WHERE vertical_id = $1 AND slug = $2', [verticalId, svSlug]);

                if (subCheck.rows.length > 0) {
                    console.log(`  ℹ️ Sub-Vertical "${svName}" already exists for "${v.name}".`);
                } else {
                    const subId = crypto.randomUUID();
                    await query(`
                        INSERT INTO sub_verticals (id, name, slug, vertical_id, display_order, created_by)
                        VALUES ($1, $2, $3, $4, $5, $6)
                    `, [subId, svName, svSlug, verticalId, subOrder++, adminId]);
                    console.log(`  ✅ Created Sub-Vertical: "${svName}"`);
                }
            }
        }

        console.log('🎉 Verticals successfully restored!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Restore failed:', err.message);
        process.exit(1);
    }
}

restore();
