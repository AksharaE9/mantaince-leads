import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from '../config/db.js';

const VERTICALS_LIST = [
    { name: 'Real Estate', slug: 'real-estate', desc: 'Residential and commercial property leads', color: '#1abc9c', icon: 'Home' },
    { name: 'Automotive', slug: 'automotive', desc: 'Car sales, leasing, and trade-in leads', color: '#e74c3c', icon: 'Car' },
    { name: 'Healthcare', slug: 'healthcare', desc: 'Medical clinics, private care, and pharmacy leads', color: '#2ecc71', icon: 'Heart' },
    { name: 'Finance & Loans', slug: 'finance-loans', desc: 'Mortgages, personal loans, and credit leads', color: '#f1c40f', icon: 'DollarSign' },
    { name: 'Education', slug: 'education', desc: 'Online courses, tutoring, and universities', color: '#9b59b6', icon: 'GraduationCap' },
    { name: 'Legal Services', slug: 'legal-services', desc: 'Attorneys, law firms, and legal consulting', color: '#34495e', icon: 'Briefcase' },
    { name: 'Travel & Tourism', slug: 'travel-tourism', desc: 'Hotels, vacation packages, and flights', color: '#3498db', icon: 'Plane' },
    { name: 'Insurance Brokers', slug: 'insurance', desc: 'Life, health, auto, and home insurance policy quotes', color: '#e67e22', icon: 'Shield' },
    { name: 'SaaS & Software', slug: 'saas-software', desc: 'Software trials, enterprise products, and tech sales', color: '#95a5a6', icon: 'Cpu' },
    { name: 'Fitness & Gyms', slug: 'fitness-gyms', desc: 'Personal training, gym memberships, and fitness coaching', color: '#d35400', icon: 'Activity' }
];

const SUB_VERTICALS_TEMPLATES = {
    'real-estate': ['Luxury Apartments', 'Commercial Offices', 'Suburban Homes', 'Industrial Warehouses', 'Vacation Rentals'],
    'automotive': ['Used SUV Buying', 'Electric Vehicles', 'Luxury Sports Cars', 'Commercial Trucks', 'Car Leasing Deals'],
    'healthcare': ['Dental Care', 'Plastic Surgery', 'Pediatricians', 'Mental Health Counseling', 'Physical Therapy'],
    'finance-loans': ['Mortgage Refinancing', 'Small Business Loans', 'Debt Consolidation', 'Student Loans', 'Crypto Trading'],
    'education': ['Coding Bootcamps', 'Language Schools', 'Executive MBA', 'High School Tutoring', 'SAT/ACT prep'],
    'legal-services': ['Family Law', 'Corporate Legal counsel', 'Intellectual Property', 'Personal Injury', 'Tax Law'],
    'travel-tourism': ['Luxury Cruise Bookings', 'Backpacking Safaris', 'All-Inclusive Resorts', 'Corporate Retreats', 'Flight tickets'],
    'insurance': ['Term Life Insurance', 'Health Coverage plans', 'Comprehensive Auto policy', 'Homeowners cover', 'Commercial Insurance'],
    'saas-software': ['CRM Enterprise trials', 'HR Management tool', 'Cloud Infrastructure hosting', 'Project Management software', 'Cybersecurity audits'],
    'fitness-gyms': ['CrossFit Memberships', 'Yoga/Pilates classes', 'Personal Trainers', 'Nutritional coaching', 'Online Workout plans']
};

const LEAD_NAMES = [
    'James Smith', 'Michael Brown', 'Robert Jones', 'Maria Garcia', 'David Miller',
    'Linda Martinez', 'Elizabeth Hernandez', 'William Nelson', 'Richard Rodriguez', 'Thomas Carter',
    'Charles Mitchell', 'Christopher Perez', 'Daniel Roberts', 'Matthew Turner', 'Anthony Phillips',
    'Mark Campbell', 'Donald Parker', 'Steven Evans', 'Paul Edwards', 'Andrew Collins'
];

const LEAD_AREAS = [
    'Downtown Austin', 'North Loop Chicago', 'Manhattan NYC', 'Beverly Hills LA', 'Soho London',
    'Downtown Seattle', 'Buckhead Atlanta', 'South Beach Miami', 'Downtown Boston', 'Capitol Hill Denver'
];

const STATUSES = ['new', 'contacted', 'converted', 'lost', 'invalid'];

async function seed() {
    console.log('🌱 Starting Production-Grade Data Seeding...');
    
    // Fetch super admin or create role if missing
    const roleRes = await query("SELECT id FROM roles WHERE name = 'super_admin'");
    const adminRoleId = roleRes.rows[0]?.id || '00000000-0000-0000-0000-000000000001';

    // 1. Create a designated mock manager user and agent users
    const mockAgentId = crypto.randomUUID();
    const pwHash = await bcrypt.hash('agent123', 12);
    
    await query(`
        INSERT INTO users (id, name, email, password_hash, role_id, is_active)
        VALUES ($1, $2, $3, $4, (SELECT id FROM roles WHERE name = 'agent'), true)
        ON CONFLICT (email) DO NOTHING
    `, [mockAgentId, 'Alex Agent', 'agent@gmail.com', pwHash]);

    console.log('👥 Mock Agent Alex verified.');

    // 2. Loop through verticals and seed them along with subverticals
    const activeVerticalIds = [];
    const subVerticalMap = {}; // vertId => [subIds]

    for (const item of VERTICALS_LIST) {
        const vertId = crypto.randomUUID();
        
        const existingRes = await query("SELECT id FROM verticals WHERE slug = $1", [item.slug]);
        let activeVertId = null;
        
        if (existingRes.rows.length > 0) {
            activeVertId = existingRes.rows[0].id;
            console.log(`ℹ️ Vertical ${item.name} already exists.`);
        } else {
            const res = await query(`
                INSERT INTO verticals (id, name, slug, description, color, icon, display_order)
                VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(MAX(display_order), 0) + 1 FROM verticals))
                RETURNING id
            `, [vertId, item.name, item.slug, item.desc, item.color, item.icon]);
            activeVertId = res.rows[0].id;
            console.log(`` + `✅ Created Vertical: ${item.name}`);
        }
        
        activeVerticalIds.push(activeVertId);

        // Seed Sub-verticals
        const subNames = SUB_VERTICALS_TEMPLATES[item.slug] || [];
        subVerticalMap[activeVertId] = [];
        
        for (const sName of subNames) {
            const sSlug = sName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const existSub = await query("SELECT id FROM sub_verticals WHERE vertical_id = $1 AND slug = $2", [activeVertId, sSlug]);
            
            if (existSub.rows.length > 0) {
                subVerticalMap[activeVertId].push(existSub.rows[0].id);
            } else {
                const subId = crypto.randomUUID();
                const subRes = await query(`
                    INSERT INTO sub_verticals (id, name, slug, vertical_id, display_order)
                    VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(display_order), 0) + 1 FROM sub_verticals WHERE vertical_id = $4))
                    RETURNING id
                `, [subId, sName, sSlug, activeVertId]);
                subVerticalMap[activeVertId].push(subRes.rows[0].id);
            }
        }
    }

    // Assign mock agent to all seeded verticals
    await query("UPDATE users SET vertical_access = $1 WHERE email = 'agent@gmail.com'", [activeVerticalIds]);

    // 3. Generate 100-200 leads across the verticals
    const totalLeadsToSeed = 150;
    let leadsCreatedCount = 0;
    
    // Clear existing mock leads to make it clean if required
    for (let i = 0; i < totalLeadsToSeed; i++) {
        const name = LEAD_NAMES[Math.floor(Math.random() * LEAD_NAMES.length)] + ' ' + (i + 1);
        const phone = '+155501' + String(1000 + i);
        const bizName = 'Business Speculator ' + (i + 1);
        const area = LEAD_AREAS[Math.floor(Math.random() * LEAD_AREAS.length)];
        const status = STATUSES[Math.floor(Math.random() * STATUSES.length)];
        
        const randomVertId = activeVerticalIds[Math.floor(Math.random() * activeVerticalIds.length)];
        const subIds = subVerticalMap[randomVertId] || [];
        const randomSubId = subIds.length > 0 ? subIds[Math.floor(Math.random() * subIds.length)] : null;
        
        // Random date within the last 90 days
        const dateOffset = Math.floor(Math.random() * 90); // 0 to 90 days ago
        const createdAt = new Date();
        createdAt.setDate(createdAt.getDate() - dateOffset);
        
        const leadId = crypto.randomUUID();
        const leadData = { area, score: Math.floor(Math.random() * 100), comments: 'Seeded lead for analytics' };
        
        const existLead = await query("SELECT id FROM leads WHERE phone = $1", [phone]);
        if (existLead.rows.length === 0) {
            await query(`
                INSERT INTO leads (id, vertical_id, sub_vertical_id, assigned_to, uploaded_by, name, phone, business_name, data, status, created_at, updated_at)
                VALUES ($1, $2, $3, $4, (SELECT id FROM users WHERE email = 'adminofleads@gmail.com' LIMIT 1), $5, $6, $7, $8, $9, $10, $10)
            `, [leadId, randomVertId, randomSubId, mockAgentId, name, phone, bizName, JSON.stringify(leadData), status, createdAt]);
            leadsCreatedCount++;
        }
    }

    console.log(`📊 Successfully seeded ${leadsCreatedCount} new leads.`);
    console.log('✅ Production Seeding complete!');
}

seed().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
});
