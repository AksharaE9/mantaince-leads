import { connectDB, query } from '../config/db.js';
import { processCsvJob } from './csvProcessor.js';
import { processRawDataJob } from './rawDataProcessor.js';
import { processDeliveryDataJob } from './deliveryDataProcessor.js';
import { processInteractionLogJob } from './interactionLogProcessor.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startImportWorkerLoop() {
  console.log('👷 LeadsBase Aurora-Backed CSV Queue Worker Polling Loop Started...');
  
  while (true) {
    try {
      // Fetch one queued job and lock it safely using FOR UPDATE SKIP LOCKED
      const res = await query(`
        UPDATE csv_upload_logs
        SET status = 'processing', processing_started_at = NOW()
        WHERE id = (
          SELECT id FROM csv_upload_logs
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `);

      const log = res.rows[0];

      if (!log) {
        // Periodically prune expired rate limit counters (approx 10% of idle cycles)
        if (Math.random() < 0.1) {
          query('DELETE FROM rate_limit_counters WHERE expires_at < NOW()').catch(err => {
            console.error('⚠️ Failed to prune expired rate limit counters:', err.message);
          });
        }

        // No jobs in queue, wait 2 seconds before checking again
        await sleep(2000);
        continue;
      }

      console.log(`⏳ Job started: Batch ${log.id} (File: ${log.file_name})`);

      const filePath = path.join(__dirname, '../../uploads', log.file_name);
      if (!fs.existsSync(filePath)) {
        throw new Error(`CSV file not found at path: ${filePath}`);
      }

      const fileBuffer = fs.readFileSync(filePath);
      const mockJob = {
        data: {
          batchId: log.id,
          fileBufferBase64: fileBuffer.toString('base64'),
          verticalId: log.vertical_id,
          subVerticalId: log.sub_vertical_id,
          uploadedBy: log.uploaded_by,
          assignedTo: log.assigned_to,
          leadType: log.lead_type || 'CALL',
          fileExt: path.extname(log.file_name || '') || '.csv'
        },
        progress: async (value) => {
          console.log(`[Worker] Job ${log.id} progress: ${value}%`);
        }
      };

      if (log.entity_type === 'raw_data') {
        await processRawDataJob(mockJob);
      } else if (log.entity_type === 'delivery_data') {
        await processDeliveryDataJob(mockJob);
      } else if (log.entity_type === 'interaction_log') {
        await processInteractionLogJob(mockJob);
      } else {
        await processCsvJob(mockJob);
      }
      console.log(`✅ Job finished successfully: Batch ${log.id}`);

    } catch (error) {
      console.error(`❌ Worker Loop Error:`, error.message);
      await sleep(5000); // Backoff on error
    }
  }
}

// ── Bootstrapping Worker ──
// Only self-starts when this file is the actual entrypoint (`node
// server/src/jobs/worker.js`, `npm run worker`, Dockerfile.worker) — NOT
// when merely imported, as app.js does unconditionally at the top for the
// startImportWorkerLoop reference it re-exports below.
//
// This used to be a bare `NODE_ENV !== 'test'` check with no import-vs-
// standalone distinction, which caused two real problems: (1) on Vercel,
// where app.js imports this module for every cold start, it started the
// infinite polling loop regardless of app.js's own `!process.env.VERCEL`
// guard around its explicit startImportWorkerLoop() call — a stray
// connection-holding loop running per serverless container; (2) even
// locally, app.js's explicit call plus this module's own auto-start meant
// two independent polling loops running in one process. `FOR UPDATE SKIP
// LOCKED` makes that safe, not free.
const isDirectEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (process.env.NODE_ENV !== 'test' && isDirectEntrypoint) {
  await connectDB();
  startImportWorkerLoop().catch(err => {
    console.error('Fatal Queue Worker Crash:', err);
    process.exit(1);
  });
}

export { startImportWorkerLoop };
export default startImportWorkerLoop;
