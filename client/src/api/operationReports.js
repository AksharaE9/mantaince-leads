import axios from './axios.js';

/**
 * Client for the persisted operation-report list (csv_upload_logs, now
 * covering bulk_upload/promote/duplicate_scan via operation_type — see
 * server/src/controllers/csv.js#getCsvLogs). No wrapper module existed for
 * this before (CsvImportModal.jsx called axios inline); introduced here
 * since OperationReportsPage.jsx is the first page-level consumer.
 */
export function getOperationReports({ page = 1, limit = 25, operationType, entityType, verticalId } = {}) {
  return axios.get('/api/v1/leads/csv/logs', {
    params: { page, limit, operationType, entityType, verticalId },
  });
}

export function getOperationReportById(batchId) {
  return axios.get(`/api/v1/leads/csv/logs/${batchId}`);
}

export function failedRowsUrl(batchId) {
  return `/api/v1/leads/csv/logs/${batchId}/failed-rows`;
}
