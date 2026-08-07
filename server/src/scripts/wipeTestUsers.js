import { connectDB, query } from '../config/db.js';

async function run() {
  try {
    await connectDB();

    // Keep only adminofleads@gmail.com - delete all dummy/test users
    const del = await query(
      `DELETE FROM users WHERE email != 'adminofleads@gmail.com' RETURNING email, name`
    );
    console.log(`🗑️  Deleted ${del.rowCount} dummy/test user(s):`);
    del.rows.forEach(u => console.log(`   - ${u.email} | ${u.name}`));

    const remaining = await query('SELECT email, name FROM users');
    console.log('\n✅ Remaining users:');
    remaining.rows.forEach(u => console.log(`   - ${u.email} | ${u.name}`));

    console.log('\n✅ Done!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

run();
