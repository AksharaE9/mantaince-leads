import React from 'react';
import { Truck, Link2 } from 'lucide-react';
import DataSectionPage from '../components/DataSectionPage.jsx';
import DeliveryDataModal from '../components/DeliveryDataModal.jsx';

const fmtDate = (v) => (v ? String(v).slice(0, 10) : '—');

const config = {
  title: 'Delivery Data',
  description: 'Delivery records — independent of Raw Data, optionally linked to a matching record.',
  icon: Truck,
  columns: [
    { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
    { key: 'employeeName', label: 'Employee Name', render: (r) => r.assignee_name || '—' },
    {
      key: 'businessName',
      label: 'Business Name',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          {r.business_name}
          {r.linked_raw_data_id && (
            <span title="Linked to a Raw Data record" className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[--accent-light] text-[--accent] text-[9px] font-black uppercase">
              <Link2 size={10} /> Linked
            </span>
          )}
        </span>
      ),
    },
    { key: 'city', label: 'City' },
    { key: 'phoneNumber', label: 'Phone Number', render: (r) => r.phone_number },
    { key: 'deliveryDate', label: 'Delivery Date', render: (r) => fmtDate(r.delivery_date) },
    { key: 'deliveryTime', label: 'Delivery Time', render: (r) => r.delivery_time || '—' },
  ],
  detailFields: [
    { key: 'businessType', label: 'Business Type', render: (r) => r.business_type || '—' },
    { key: 'area', label: 'Area' },
    { key: 'address', label: 'Address' },
    { key: 'appointmentDate', label: 'Appointment Date', render: (r) => fmtDate(r.appointment_date) },
    { key: 'appointmentTimings', label: 'Appointment Timings', render: (r) => r.appointment_timings || '—' },
    { key: 'remarks', label: 'Remarks' },
  ],
  sortableColumns: ['date', 'businessName', 'city', 'deliveryDate'],
  endpoints: {
    list: '/api/v1/delivery-data',
    exportCsv: '/api/v1/delivery-data/export/csv',
  },
  filenamePrefix: 'delivery-data',
  ModalComponent: DeliveryDataModal,
  emptyStateText: 'No delivery data yet — add one or import a file.',
};

export default function DeliveryDataPage() {
  return <DataSectionPage config={config} />;
}
