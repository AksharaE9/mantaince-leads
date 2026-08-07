import { query } from '../config/db.js';
import { invalidateOnTaxonomyChange } from '../services/cache.js';
import crypto from 'crypto';

const generateSlug = (name) => {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
};

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

const newTaxonomy = [
    {
        name: 'MilletPro',
        description: 'MilletPro Vertical',
        color: '#2E7D32', // Green
        icon: 'Package',
        subVerticals: ['Specific Affiliates']
    },
    {
        name: 'Pooja - Jaya Janrdhana',
        description: 'Pooja Jaya Janrdhana Vertical',
        color: '#D84315', // Deep Orange
        icon: 'Flame',
        subVerticals: [
            'Specific Affiliate',
            'Wholesaler, Distributors',
            'Retail Shops',
            'To Businesses'
        ]
    },
    {
        name: 'Soaps - Aroma Dew',
        description: 'Aroma Dew Soaps Vertical',
        color: '#00838F', // Teal
        icon: 'Sparkles',
        subVerticals: ['Hotels, Resorts']
    },
    {
        name: 'ERP SaaS',
        description: 'ERP SaaS Vertical',
        color: '#1565C0', // Blue
        icon: 'Cpu',
        subVerticals: ['Standard']
    },
    {
        name: 'Competitions',
        description: 'Competitions Vertical',
        color: '#AD1457', // Pink
        icon: 'Trophy',
        subVerticals: ['Standard']
    },
    {
        name: 'Ace It Up',
        description: 'Ace It Up Vertical',
        color: '#6A1B9A', // Purple
        icon: 'Award',
        subVerticals: ['Standard']
    },
    {
        name: 'Etiquettes',
        description: 'Etiquettes Vertical',
        color: '#F9A825', // Yellow/Amber
        icon: 'BookOpen',
        subVerticals: ['Standard']
    },
    {
        name: 'Talenty consulting',
        description: 'Talenty consulting Vertical',
        color: '#3F51B5', // Indigo
        icon: 'Users',
        subVerticals: ['Standard']
    }
];

async function seed() {
    try {
        console.log('🌱 Starting seeding of new Verticals & Sub-Verticals...');

        // 1. Get default super admin ID for created_by
        const adminRes = await query("SELECT id FROM users WHERE email = 'adminofleads@gmail.com'");
        const adminId = adminRes.rows[0]?.id || null;
        if (!adminId) {
            console.error('❌ Super Admin user not found. Please run core seed first.');
            process.exit(1);
        }

        // 2. Fetch max display order for verticals
        const maxOrderRes = await query('SELECT COALESCE(MAX(display_order), 0) AS max FROM verticals');
        let nextDisplayOrder = parseInt(maxOrderRes.rows[0].max, 10) + 1;

        for (const v of newTaxonomy) {
            const slug = generateSlug(v.name);

            // Check if vertical already exists
            const vertCheck = await query('SELECT id FROM verticals WHERE slug = $1', [slug]);
            let verticalId;

            if (vertCheck.rows.length > 0) {
                verticalId = vertCheck.rows[0].id;
                console.log(`ℹ️ Vertical "${v.name}" already exists. Using ID: ${verticalId}`);
            } else {
                verticalId = crypto.randomUUID();
                const vertRes = await query(`
                    INSERT INTO verticals (id, name, slug, description, color, icon, display_order, created_by, statuses)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    RETURNING *
                `, [
                    verticalId, v.name, slug, v.description, v.color, v.icon,
                    nextDisplayOrder++, adminId, JSON.stringify(defaultStatuses)
                ]);
                console.log(`✅ Created Vertical: "${v.name}"`);
            }

            // Create Sub-Verticals
            let subOrder = 1;
            for (const svName of v.subVerticals) {
                const svSlug = generateSlug(svName);
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

        // 3. Clear taxonomy cache
        console.log('🔄 Invalidating cache...');
        await invalidateOnTaxonomyChange(null);
        console.log('🎉 Seeding successfully completed!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Seeding failed with error:', err.message);
        process.exit(1);
    }
}

seed();
