/**
 * seedVerticals.js  –  Creates all required verticals & sub-verticals
 * Usage: node server/src/scripts/seedVerticals.js
 */
import { connectDB, query } from '../config/db.js';
import crypto from 'crypto';

const slug = (name) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const VERTICALS = [
  {
    name: 'MilletPro',
    color: '#7C3AED',
    icon: 'Wheat',
    order: 1,
    subs: ['Specific Affiliates'],
  },
  {
    name: 'Pooja - Jaya Janrdhana',
    color: '#F59E0B',
    icon: 'Star',
    order: 2,
    subs: ['Specific Affiliate', 'Wholesaler, Distributors', 'Retail Shops', 'To Businesses'],
  },
  {
    name: 'Soaps - Aroma Dew',
    color: '#06B6D4',
    icon: 'Droplets',
    order: 3,
    subs: ['Hotels, Resorts'],
  },
  {
    name: 'ERP SaaS',
    color: '#10B981',
    icon: 'Server',
    order: 4,
    subs: ['Standard'],
  },
  {
    name: 'Competitions',
    color: '#EF4444',
    icon: 'Trophy',
    order: 5,
    subs: ['Standard'],
  },
  {
    name: 'Ace It Up',
    color: '#3B82F6',
    icon: 'Zap',
    order: 6,
    subs: ['Standard'],
  },
  {
    name: 'Etiquettes',
    color: '#EC4899',
    icon: 'Sparkles',
    order: 7,
    subs: ['Standard'],
  },
];

async function seed() {
  try {
    await connectDB();
    console.log('🌱 Seeding verticals & sub-verticals...\n');

    // Get admin user id
    const adminRes = await query(`SELECT id FROM users WHERE email = 'adminofleads@gmail.com' LIMIT 1`);
    const adminId = adminRes.rows[0]?.id || null;
    if (!adminId) {
      console.error('❌ adminofleads@gmail.com not found. Aborting.');
      process.exit(1);
    }

    for (const v of VERTICALS) {
      const vSlug = slug(v.name);

      // Upsert vertical
      const existing = await query(`SELECT id FROM verticals WHERE slug = $1`, [vSlug]);
      let verticalId;

      if (existing.rows.length > 0) {
        verticalId = existing.rows[0].id;
        await query(
          `UPDATE verticals SET name=$1, color=$2, icon=$3, display_order=$4, is_active=true, updated_at=NOW() WHERE id=$5`,
          [v.name, v.color, v.icon, v.order, verticalId]
        );
        console.log(`♻️  Updated vertical: ${v.name}`);
      } else {
        verticalId = crypto.randomUUID();
        await query(
          `INSERT INTO verticals (id, name, slug, color, icon, display_order, is_active, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
          [verticalId, v.name, vSlug, v.color, v.icon, v.order, adminId]
        );
        console.log(`✅ Created vertical: ${v.name}`);
      }

      // Seed sub-verticals
      for (let i = 0; i < v.subs.length; i++) {
        const subName = v.subs[i];
        const subSlug = slug(subName);

        const existingSub = await query(
          `SELECT id FROM sub_verticals WHERE vertical_id=$1 AND slug=$2`,
          [verticalId, subSlug]
        );

        if (existingSub.rows.length > 0) {
          console.log(`   ♻️  Sub-vertical already exists: ${subName}`);
        } else {
          const subId = crypto.randomUUID();
          await query(
            `INSERT INTO sub_verticals (id, name, slug, vertical_id, display_order, is_active, created_by)
             VALUES ($1, $2, $3, $4, $5, true, $6)`,
            [subId, subName, subSlug, verticalId, i + 1, adminId]
          );
          console.log(`   ✅ Created sub-vertical: ${subName}`);
        }
      }
    }

    // Refresh materialized views
    try {
      await query('SELECT refresh_mv_vertical_tree()');
      console.log('\n✅ Materialized view refreshed.');
    } catch (_) {}

    // Final verification
    console.log('\n📋 Final state:');
    const verts = await query('SELECT id, name, slug FROM verticals ORDER BY display_order');
    for (const v of verts.rows) {
      const subs = await query(
        'SELECT name FROM sub_verticals WHERE vertical_id=$1 AND is_active=true ORDER BY display_order',
        [v.id]
      );
      console.log(`  ✅ ${v.name} (${v.slug})`);
      subs.rows.forEach(s => console.log(`       · ${s.name}`));
    }

    console.log('\n✅ Seeding complete!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding failed:', err.message);
    process.exit(1);
  }
}

seed();
