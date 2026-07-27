// Cleanup companion to scripts/production-readiness-test.js. Removes ONLY
// rows tagged `LOADTEST-<runId>-...` in a given vertical — scoped by exact
// tag match on every DELETE, never a blanket "all rows/all logs in this
// vertical" query. (A blanket csv_upload_logs delete in an earlier version
// of this cleanup process removed one real pre-existing log row by mistake —
// this script exists specifically so that can't happen again.)
//
// Requires direct DB access (imports server/src/config/db.js), which means:
//   - Works against any database you hold PGHOST/PGUSER/PGPASSWORD for
//     (typically a local/dev/staging DB — see server/.env).
//   - Cannot clean up a *production* Vercel deployment unless you separately
//     hold that deployment's DB credentials — Raw Data and Delivery Data
//     have no DELETE route at all (checked: `grep router.delete
//     server/src/routes/{rawData,deliveryData}.js` → no matches), so there is
//     no API-based cleanup path for those two entities in any environment.
//     Never run scripts/production-readiness-test.js's Raw Data/Delivery
//     Data paths against a database you don't hold direct credentials for.
//   - Leads/Positives (cost_conversions) DO have DELETE /api/v1/leads/:id,
//     so those two can be cleaned up via the API alone if you only have
//     application credentials, not DB credentials — see the `--via-api`
//     mode below.
//
// Usage (direct DB — cleans all 4 tables + csv_upload_logs):
//   node scripts/production-readiness-cleanup.js <runId> <verticalId>              (dry run)
//   node scripts/production-readiness-cleanup.js <runId> <verticalId> --confirm    (delete)
//
// Usage (API-only — Leads/Positives only, for environments with no DB access):
//   PRODREADY_EMAIL=... PRODREADY_PASSWORD=... \
//     node scripts/production-readiness-cleanup.js <runId> <verticalId> --via-api <baseUrl> [--confirm]

const [, , runId, verticalId, ...rest] = process.argv;
const confirm = rest.includes('--confirm');
const viaApiIdx = rest.indexOf('--via-api');
const baseUrl = viaApiIdx >= 0 ? rest[viaApiIdx + 1] : null;

if (!runId || !verticalId) {
    console.error('Usage: node scripts/production-readiness-cleanup.js <runId> <verticalId> [--confirm] [--via-api <baseUrl>]');
    process.exit(1);
}

// production-readiness-test.js's auditSection appends a per-check suffix to
// runId before tagging (e.g. `${runId}v`, `${runId}m`, `${runId}dwf`), so the
// tags actually written are `LOADTEST-<runId><suffix>-<section>-<n>`, NOT
// `LOADTEST-<runId>-...` — matching runId as a prefix (no required trailing
// hyphen) is what actually catches every variant. Pass a full timestamp-style
// runId (the harness's own examples do) so it can't be a literal string
// prefix of some other unrelated run's id.
const tagPattern = `LOADTEST-${runId}%`;
const tagSubstring = `LOADTEST-${runId}`;

async function runViaApi() {
    const email = process.env.PRODREADY_EMAIL;
    const password = process.env.PRODREADY_PASSWORD;
    if (!email || !password) throw new Error('Set PRODREADY_EMAIL / PRODREADY_PASSWORD to use --via-api.');

    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    const { data } = await loginRes.json();
    const token = data.accessToken;

    async function findTagged(leadType) {
        const url = `${baseUrl}/api/v1/leads?verticalId=${verticalId}&limit=500&search=${encodeURIComponent(tagSubstring)}${leadType ? `&leadType=${leadType}` : ''}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const json = await res.json();
        return json.data || [];
    }

    const rows = [...await findTagged(), ...await findTagged('POSITIVE')];
    console.log(`[via-api] Found ${rows.length} tagged Leads/Positives rows in ${verticalId}.`);
    rows.forEach(r => console.log(' -', r.businessName || r.business_name, r.id));

    if (!confirm) {
        console.log('\nDry run — pass --confirm to delete.');
        console.log('\nNOTE: --via-api only reaches Leads/Positives (cost_conversions has a DELETE route).');
        console.log('Raw Data / Delivery Data rows tagged for this runId, if any, cannot be removed');
        console.log('this way and need direct DB access — see this file\'s header comment.');
        return;
    }

    let deleted = 0, failed = 0;
    for (const row of rows) {
        const res = await fetch(`${baseUrl}/api/v1/leads/${row.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 200 || res.status === 204) deleted++; else { failed++; console.log('  delete failed:', row.id, res.status); }
    }
    console.log(`Deleted ${deleted}, failed ${failed}.`);

    const remaining = [...await findTagged(), ...await findTagged('POSITIVE')];
    console.log(`Remaining tagged rows: ${remaining.length} (must be 0).`);
    process.exit(remaining.length === 0 && failed === 0 ? 0 : 1);
}

async function runViaDb() {
    const { connectDB, query } = await import('../server/src/config/db.js');
    await connectDB();

    async function countScoped() {
        const logs = await query(`SELECT id FROM csv_upload_logs WHERE vertical_id = $1 AND original_file_name LIKE $2`, [verticalId, tagPattern]);
        const batchIds = logs.rows.map(r => r.id);
        const leads = await query(
            `SELECT id FROM cost_conversions WHERE vertical_id = $1 AND (csv_batch_id = ANY($2::uuid[]) OR (data->>'remarks') LIKE $3 OR business_name LIKE $3)`,
            [verticalId, batchIds, tagPattern]
        );
        const rawData = await query(
            `SELECT id FROM raw_data WHERE vertical_id = $1 AND (csv_batch_id = ANY($2::uuid[]) OR remarks LIKE $3 OR business_name LIKE $3)`,
            [verticalId, batchIds, tagPattern]
        );
        const deliveryData = await query(
            `SELECT id FROM delivery_data WHERE vertical_id = $1 AND (csv_batch_id = ANY($2::uuid[]) OR remarks LIKE $3 OR business_name LIKE $3)`,
            [verticalId, batchIds, tagPattern]
        );
        return { batchIds, leadIds: leads.rows.map(r => r.id), rawDataIds: rawData.rows.map(r => r.id), deliveryDataIds: deliveryData.rows.map(r => r.id) };
    }

    async function otherVerticalsSnapshot() {
        const res = await query(`
            SELECT (SELECT COUNT(*) FROM cost_conversions WHERE vertical_id != $1) AS leads_other,
                   (SELECT COUNT(*) FROM raw_data WHERE vertical_id != $1) AS raw_data_other,
                   (SELECT COUNT(*) FROM delivery_data WHERE vertical_id != $1) AS delivery_data_other
        `, [verticalId]);
        return res.rows[0];
    }

    console.log(`\n=== Cleanup scope: runId=${runId} vertical=${verticalId} tag='${tagPattern}' mode=${confirm ? 'DELETE' : 'DRY RUN'} ===\n`);

    const before = await countScoped();
    const otherBefore = await otherVerticalsSnapshot();
    console.log('Matched for deletion:', {
        csv_upload_logs: before.batchIds.length, cost_conversions: before.leadIds.length,
        raw_data: before.rawDataIds.length, delivery_data: before.deliveryDataIds.length,
    });
    console.log('Other-verticals baseline (must be unchanged after):', otherBefore);

    if (!confirm) {
        console.log('\nDry run only — no rows deleted. Re-run with --confirm to delete.');
        process.exit(0);
    }

    const delLeads = before.leadIds.length ? await query(`DELETE FROM cost_conversions WHERE id = ANY($1::uuid[])`, [before.leadIds]) : { rowCount: 0 };
    const delRaw = before.rawDataIds.length ? await query(`DELETE FROM raw_data WHERE id = ANY($1::uuid[])`, [before.rawDataIds]) : { rowCount: 0 };
    const delDelivery = before.deliveryDataIds.length ? await query(`DELETE FROM delivery_data WHERE id = ANY($1::uuid[])`, [before.deliveryDataIds]) : { rowCount: 0 };
    // Scoped by the SAME tag-matched id list computed above — never a
    // "DELETE ... WHERE vertical_id = X" on csv_upload_logs.
    const delLogs = before.batchIds.length ? await query(`DELETE FROM csv_upload_logs WHERE id = ANY($1::uuid[])`, [before.batchIds]) : { rowCount: 0 };
    console.log('Deleted:', { cost_conversions: delLeads.rowCount, raw_data: delRaw.rowCount, delivery_data: delDelivery.rowCount, csv_upload_logs: delLogs.rowCount });

    const after = await countScoped();
    const otherAfter = await otherVerticalsSnapshot();
    const allGone = after.batchIds.length === 0 && after.leadIds.length === 0 && after.rawDataIds.length === 0 && after.deliveryDataIds.length === 0;
    const otherUnchanged = otherBefore.leads_other === otherAfter.leads_other
        && otherBefore.raw_data_other === otherAfter.raw_data_other
        && otherBefore.delivery_data_other === otherAfter.delivery_data_other;

    console.log(`\n${allGone ? '✅' : '❌'} All tagged rows removed`);
    console.log(`${otherUnchanged ? '✅' : '❌'} Other verticals untouched`, { before: otherBefore, after: otherAfter });
    process.exit(allGone && otherUnchanged ? 0 : 1);
}

(baseUrl ? runViaApi() : runViaDb()).catch(err => { console.error('❌ Cleanup error:', err); process.exit(1); });
