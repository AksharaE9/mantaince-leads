import { connectDB, query } from '../config/db.js';
import { processCsvJob } from './csvProcessor.js';
import { processRawDataJob } from './rawDataProcessor.js';
import { processDeliveryDataJob } from './deliveryDataProcessor.js';
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
if (process.env.NODE_ENV !== 'test') {
  await connectDB();
  startImportWorkerLoop().catch(err => {
    console.error('Fatal Queue Worker Crash:', err);
    process.exit(1);
  });
}

export { startImportWorkerLoop };
export default startImportWorkerLoop;
