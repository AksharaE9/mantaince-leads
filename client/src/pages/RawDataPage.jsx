import React from 'react';
import { Database } from 'lucide-react';
import DataSectionPage from '../components/DataSectionPage.jsx';
import RawDataModal from '../components/RawDataModal.jsx';

// Display-only date formatting: the API returns DATE columns as ISO strings
// ("2026-07-24T00:00:00.000Z") that already round-trip safely as UTC — take
// the YYYY-MM-DD date portion and reorder it as a plain string operation
// (never re-parse through `new Date()` for display — see the timezone-gotcha
// discipline established in rawDataProcessor.js) into DD-MM-YYYY, matching
// how dates already display everywhere else in this app (e.g. the Edit COS
// panel) and in the bulk-upload template's sample rows.
const fmtDate = (v) => {
  if (!v) return '-';
  const [y, m, d] = String(v).slice(0, 10).split('-');
  return y && m && d ? `${d}-${m}-${y}` : '-';
};

const config = {
  title: 'Raw Data',
  description: 'Field-collected business data — not yet converted into a lead.',
  icon: Database,
  columns: [
    { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
    { key: 'employeeName', label: 'Employee Name', render: (r) => r.assignee_name || '-' },
    { key: 'businessName', label: 'Business Name' },
    { key: 'city', label: 'City' },
    { key: 'phoneNumber', label: 'Phone Number', render: (r) => r.phone_number },
    { key: 'appointmentDate', label: 'Appointment Date', render: (r) => fmtDate(r.appointment_date) },
  ],
  detailFields: [
    { key: 'businessType', label: 'Business Type', render: (r) => r.business_type || '-' },
    { key: 'area', label: 'Area' },
    { key: 'address', label: 'Address' },
    { key: 'appointmentTimings', label: 'Appointment Timings', render: (r) => r.appointment_timings || '-' },
    { key: 'remarks', label: 'Remarks' },
  ],
  sortableColumns: ['date', 'businessName', 'city'],
  endpoints: {
    list: '/api/v1/raw-data',
    exportCsv: '/api/v1/raw-data/export/csv',
  },
  filenamePrefix: 'raw-data',
  ModalComponent: RawDataModal,
  emptyStateText: 'No raw data yet — add one or import a file.',
};

export default function RawDataPage() {
  return <DataSectionPage config={config} />;
}
