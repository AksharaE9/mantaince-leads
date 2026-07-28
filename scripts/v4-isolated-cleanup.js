// Cleanup companion to scripts/v4-isolated-audit.js. Removes ONLY rows
// tagged `V4AUD-<runId>-...` inside the two dedicated test verticals created
// by that script's `setup` command — scoped by exact tag-substring match on
// every DELETE, never a blanket "all rows in this vertical" query, so a
// pre-existing real row can never be caught by accident.
//
// Direct DB access (server/src/config/db.js) — same justification as
// scripts/production-readiness-cleanup.js: read-only verification and
// cleanup deletes are a different concern from the mutations under test,
// which always went through the real API in v4-isolated-audit.js.
//
// Both test verticals have ON DELETE CASCADE from verticals -> {sub_verticals,
// cost_conversions, raw_data, delivery_data, csv_upload_logs}, and
// cost_conversions -> follow_ups also cascades. The explicit tag-scoped
// deletes below run first (and are what's actually verified against exact
// counts); the final `DELETE FROM verticals` is a belt-and-suspenders step
// that would cascade-clean anything left, but by that point the scoped
// counts must already be zero, or something the tag pattern didn't catch.
//
// Usage:
//   node scripts/v4-isolated-cleanup.js <runId> <verticalIdA> <verticalIdB>              (dry run)
//   node scripts/v4-isolated-cleanup.js <runId> <verticalIdA> <verticalIdB> --confirm    (delete)

const [, , runId, verticalIdA, verticalIdB, ...rest] = process.argv;
const confirm = rest.includes('--confirm');

if (!runId || !verticalIdA || !verticalIdB) {
  console.error('Usage: node scripts/v4-isolated-cleanup.js <runId> <verticalIdA> <verticalIdB> [--confirm]');
  process.exit(1);
}

const tagPattern = `V4AUD-${runId}%`;
const verticalIds = [verticalIdA, verticalIdB];

async function main() {
  const { connectDB, query } = await import('../server/src/config/db.js');
  await connectDB();

  async function countScoped() {
    const logs = await query(
      `SELECT id FROM csv_upload_logs WHERE vertical_id = ANY($1::uuid[]) AND original_file_name LIKE $2`,
      [verticalIds, tagPattern]
    );
    const batchIds = logs.rows.map((r) => r.id);

    const leadsMatchClause = batchIds.length
      ? `(business_name LIKE $2 OR (data->>'remarks') LIKE $2 OR csv_batch_id = ANY($3::uuid[]))`
      : `(business_name LIKE $2 OR (data->>'remarks') LIKE $2)`;
    const leads = await query(
      `SELECT id FROM cost_conversions WHERE vertical_id = ANY($1::uuid[]) AND ${leadsMatchClause}`,
      batchIds.length ? [verticalIds, tagPattern, batchIds] : [verticalIds, tagPattern]
    );

    const rawData = await query(
      `SELECT id FROM raw_data WHERE vertical_id = ANY($1::uuid[]) AND business_name LIKE $2`,
      [verticalIds, tagPattern]
    );
    const deliveryData = await query(
      `SELECT id FROM delivery_data WHERE vertical_id = ANY($1::uuid[]) AND business_name LIKE $2`,
      [verticalIds, tagPattern]
    );
    const leadIds = leads.rows.map((r) => r.id);
    // follow_ups.id is VARCHAR (crypto.randomUUID() stored as a string, not
    // a real uuid column — see promoted_to_follow_up_id's VARCHAR(50) FK in
    // db.js) while cost_conversion_id IS a uuid FK to cost_conversions(id),
    // so only that side of this query casts to ::uuid[].
    const followUps = leadIds.length
      ? await query(`SELECT id FROM follow_ups WHERE cost_conversion_id = ANY($1::uuid[])`, [leadIds])
      : { rows: [] };

    return {
      batchIds,
      leadIds,
      rawDataIds: rawData.rows.map((r) => r.id),
      deliveryDataIds: deliveryData.rows.map((r) => r.id),
      followUpIds: followUps.rows.map((r) => r.id),
    };
  }

  async function otherVerticalsSnapshot() {
    const res = await query(
      `SELECT
        (SELECT COUNT(*) FROM cost_conversions WHERE vertical_id != ALL($1::uuid[])) AS leads_other,
        (SELECT COUNT(*) FROM raw_data WHERE vertical_id != ALL($1::uuid[])) AS raw_data_other,
        (SELECT COUNT(*) FROM delivery_data WHERE vertical_id != ALL($1::uuid[])) AS delivery_data_other,
        (SELECT COUNT(*) FROM follow_ups f JOIN cost_conversions c ON c.id = f.cost_conversion_id WHERE c.vertical_id != ALL($1::uuid[])) AS follow_ups_other,
        (SELECT COUNT(*) FROM csv_upload_logs WHERE vertical_id != ALL($1::uuid[])) AS csv_logs_other,
        (SELECT COUNT(*) FROM verticals) AS verticals_total`,
      [verticalIds]
    );
    return res.rows[0];
  }

  console.log(`\n=== v4-isolated-audit cleanup: runId=${runId} verticals=[${verticalIdA}, ${verticalIdB}] tag='${tagPattern}' mode=${confirm ? 'DELETE' : 'DRY RUN'} ===\n`);

  const before = await countScoped();
  const otherBefore = await otherVerticalsSnapshot();
  console.log('Matched for deletion:', {
    csv_upload_logs: before.batchIds.length,
    cost_conversions: before.leadIds.length,
    raw_data: before.rawDataIds.length,
    delivery_data: before.deliveryDataIds.length,
    follow_ups: before.followUpIds.length,
  });
  console.log('Baseline outside these 2 test verticals (must be unchanged after):', otherBefore);

  if (!confirm) {
    console.log('\nDry run only — no rows deleted. Re-run with --confirm to delete.');
    process.exit(0);
  }

  const delFollowUps = before.followUpIds.length ? await query(`DELETE FROM follow_ups WHERE id = ANY($1::varchar[])`, [before.followUpIds]) : { rowCount: 0 };
  const delLeads = before.leadIds.length ? await query(`DELETE FROM cost_conversions WHERE id = ANY($1::uuid[])`, [before.leadIds]) : { rowCount: 0 };
  const delRaw = before.rawDataIds.length ? await query(`DELETE FROM raw_data WHERE id = ANY($1::uuid[])`, [before.rawDataIds]) : { rowCount: 0 };
  const delDelivery = before.deliveryDataIds.length ? await query(`DELETE FROM delivery_data WHERE id = ANY($1::uuid[])`, [before.deliveryDataIds]) : { rowCount: 0 };
  const delLogs = before.batchIds.length ? await query(`DELETE FROM csv_upload_logs WHERE id = ANY($1::uuid[])`, [before.batchIds]) : { rowCount: 0 };
  console.log('Deleted (tag-scoped):', {
    follow_ups: delFollowUps.rowCount, cost_conversions: delLeads.rowCount,
    raw_data: delRaw.rowCount, delivery_data: delDelivery.rowCount, csv_upload_logs: delLogs.rowCount,
  });

  // Belt-and-suspenders: remove the two isolated test verticals themselves.
  // ON DELETE CASCADE cleans up sub_verticals + anything the tag pattern
  // above might have missed; verified against the post-delete count below.
  const delVerticals = await query(`DELETE FROM verticals WHERE id = ANY($1::uuid[]) RETURNING id`, [verticalIds]);
  console.log('Deleted test verticals:', delVerticals.rows.map((r) => r.id));

  const after = await countScoped();
  const otherAfter = await otherVerticalsSnapshot();
  const verticalsGoneRes = await query(`SELECT id FROM verticals WHERE id = ANY($1::uuid[])`, [verticalIds]);

  const allGone = after.batchIds.length === 0 && after.leadIds.length === 0 && after.rawDataIds.length === 0
    && after.deliveryDataIds.length === 0 && after.followUpIds.length === 0;
  const verticalsGone = verticalsGoneRes.rows.length === 0;
  const otherUnchanged = otherBefore.leads_other === otherAfter.leads_other
    && otherBefore.raw_data_other === otherAfter.raw_data_other
    && otherBefore.delivery_data_other === otherAfter.delivery_data_other
    && otherBefore.follow_ups_other === otherAfter.follow_ups_other
    && otherBefore.csv_logs_other === otherAfter.csv_logs_other
    && Number(otherBefore.verticals_total) - 2 === Number(otherAfter.verticals_total);

  console.log(`\n${allGone ? '✅' : '❌'} All tagged rows removed`, { before, after });
  console.log(`${verticalsGone ? '✅' : '❌'} Both test verticals removed`);
  console.log(`${otherUnchanged ? '✅' : '❌'} Everything outside the 2 test verticals is byte-for-byte unchanged`, { before: otherBefore, after: otherAfter });
  process.exit(allGone && verticalsGone && otherUnchanged ? 0 : 1);
}

main().catch((err) => { console.error('❌ Cleanup error:', err); process.exit(1); });
