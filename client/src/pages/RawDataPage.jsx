import React from 'react';
import { Database } from 'lucide-react';
import DataSectionPage from '../components/DataSectionPage.jsx';
import RawDataModal from '../components/RawDataModal.jsx';

const fmtDate = (v) => {
  if (!v) return '-';
  const [y, m, d] = String(v).slice(0, 10).split('-');
  return y && m && d ? `${d}-${m}-${y}` : '-';
};

const config = {
  title: 'Raw Data',
  description: 'Field-collected business data across all verticals and sub-verticals.',
  icon: Database,
  columns: [
    { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
    { key: 'employeeName', label: 'Employee Name', render: (r) => r.assignee_name || r.employee_name_raw || '-' },
    { key: 'subVertical', label: 'Sub-Vertical', render: (r) => r.sub_vertical_name || '-' },
    { key: 'productService', label: 'Product/Service', render: (r) => r.product_service || r.business_type || '-' },
    { key: 'leadName', label: 'Lead Name', render: (r) => r.lead_name || r.business_name || '-' },
    { key: 'contactPerson', label: 'Contact Person', render: (r) => r.contact_person || '-' },
    { key: 'phoneNumber', label: 'Mobile Number', render: (r) => r.phone_number || '-' },
    { key: 'city', label: 'City', render: (r) => r.city || '-' },
    { key: 'callStatus', label: 'Call Status', render: (r) => r.call_status || '-' },
    { key: 'followUpDate', label: 'Follow-up Date', render: (r) => fmtDate(r.follow_up_date || r.appointment_date) },
    { key: 'converted', label: 'Converted', render: (r) => r.converted || '-' },
  ],
  detailFields: [
    { key: 'alternateNumber', label: 'Alternate Number(If Any)', render: (r) => r.alternate_number || '-' },
    { key: 'area', label: 'Area', render: (r) => r.area || '-' },
    { key: 'mapLocation', label: 'Map Location', render: (r) => r.map_location || r.address || '-' },
    { key: 'customerResponse', label: 'Customer Response', render: (r) => r.customer_response || '-' },
    { key: 'followUpRequired', label: 'Follow-up Required', render: (r) => r.follow_up_required || '-' },
    { key: 'followUpTime', label: 'Follow-up Time', render: (r) => r.follow_up_time || r.appointment_timings || '-' },
    { key: 'nextAction', label: 'Next Action', render: (r) => r.next_action || '-' },
    { key: 'remarks', label: 'Remarks', render: (r) => r.remarks || '-' },
  ],
  sortableColumns: ['date', 'leadName', 'contactPerson', 'phoneNumber', 'city', 'area', 'callStatus', 'followUpDate', 'converted'],
  endpoints: {
    list: '/api/v1/raw-data',
    exportCsv: '/api/v1/raw-data/export/csv',
  },
  filenamePrefix: 'raw-data',
  ModalComponent: RawDataModal,
  emptyStateText: 'No raw data yet — add one or import an Excel/CSV file.',
};

export default function RawDataPage() {
  return <DataSectionPage config={config} />;
}
