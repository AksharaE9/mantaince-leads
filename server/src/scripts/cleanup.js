import { query } from '../config/db.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const cleanup = async () => {
  try {
    console.log('🧹 Starting deep cleanup...');

    // Delete in order of dependencies
    await query('DELETE FROM audit_logs');
    await query('DELETE FROM sessions');
    await query('DELETE FROM follow_ups');
    await query('DELETE FROM lead_custom_values');
    await query('DELETE FROM custom_fields');
    await query('DELETE FROM leads');
    await query('DELETE FROM lead_stages');
    await query('DELETE FROM user_assignments');
    await query('DELETE FROM field_configs');
    await query('DELETE FROM csv_upload_logs');
    await query('DELETE FROM sub_verticals');
    await query('DELETE FROM verticals');

    // Get Super Admin role ID
    const roleRes = await query("SELECT id FROM roles WHERE name = 'super_admin'");
    const adminRoleId = roleRes.rows[0]?.id;

    if (!adminRoleId) {
        console.error('❌ Super Admin role not found. Run seed first.');
        return;
    }

    // Delete users except the adminofleads@gmail.com
    const adminEmail = 'adminofleads@gmail.com';
    await query('DELETE FROM users WHERE email != $1', [adminEmail]);

    // Ensure the admin user exists and has the right password
    const passwordHash = await bcrypt.hash('hile@dsbase@123', 12);
    await query(`
        INSERT INTO users (id, name, email, password_hash, role_id, is_active, is_approved)
        VALUES ($1, $2, $3, $4, $5, true, true)
        ON CONFLICT (email) DO UPDATE SET password_hash = $4, role_id = $5, is_approved = true, updated_at = NOW()
    `, [crypto.randomUUID(), 'Super Administrator', adminEmail, passwordHash, adminRoleId]);

    console.log('✅ Cleanup complete. Only Super Admin (adminofleads@gmail.com) remains.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Cleanup failed:', err.message);
    process.exit(1);
  }
};

cleanup();
