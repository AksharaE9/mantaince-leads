import React from 'react';
import { Truck, Link2, ExternalLink } from 'lucide-react';
import DataSectionPage from '../components/DataSectionPage.jsx';
import DeliveryDataModal from '../components/DeliveryDataModal.jsx';

// Display-only date formatting: YYYY-MM-DD -> DD-MM-YYYY, never re-parses
// through `new Date()` — matches how dates display everywhere else in this app.
const fmtDate = (v) => {
  if (!v) return '-';
  const [y, m, d] = String(v).slice(0, 10).split('-');
  return y && m && d ? `${d}-${m}-${y}` : '-';
};

// Clickable map link if value looks like a URL, otherwise plain text.
const renderAddress = (r) => {
  const loc = r.address || '';
  if (!loc) return '-';
  if (/^https?:\/\//i.test(loc)) {
    return (
      <a
        href={loc}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[--accent] hover:underline font-medium"
      >
        <span>View Map</span>
        <ExternalLink size={12} />
      </a>
    );
  }
  return <span className="truncate max-w-xs block" title={loc}>{loc}</span>;
};

const renderCallStatus = (r) => {
  const st = r.call_status || '';
  if (!st) return '-';
  const lower = st.toLowerCase();
  let badgeClass = 'bg-stone-100 text-stone-700 border-stone-200';
  if (lower.includes('connect')) badgeClass = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  else if (lower.includes('busy') || lower.includes('unreachable') || lower.includes('not reachable')) badgeClass = 'bg-amber-50 text-amber-700 border-amber-200';
  else if (lower.includes('switched') || lower.includes('wrong') || lower.includes('disconnect')) badgeClass = 'bg-red-50 text-red-700 border-red-200';
  else if (lower.includes('callback') || lower.includes('follow')) badgeClass = 'bg-blue-50 text-blue-700 border-blue-200';
  return (
    <span className={`inline-block px-2 py-0.5 text-[11px] font-bold rounded-full border ${badgeClass}`}>
      {st}
    </span>
  );
};

const renderConverted = (r) => {
  const conv = (r.converted || '').trim().toUpperCase();
  if (!conv) return '-';
  if (conv === 'Y' || conv === 'YES') {
    return <span className="px-2 py-0.5 text-[11px] font-black rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">Y</span>;
  }
  if (conv === 'N' || conv === 'NO') {
    return <span className="px-2 py-0.5 text-[11px] font-black rounded-full bg-stone-100 text-stone-600 border border-stone-300">N</span>;
  }
  return <span>{conv}</span>;
};

const config = {
  title: 'Delivery Data',
  description: 'Delivery records — independent of Raw Data, optionally linked to a matching record.',
  icon: Truck,
  columns: [
    { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
    { key: 'employeeName', label: 'Employee Name', render: (r) => r.assignee_name || r.employee_name_raw || '-' },
    {
      key: 'businessName',
      label: 'Business Name',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          {r.business_name || '-'}
          {r.linked_raw_data_id && (
            <span title="Linked to a Raw Data record" className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[--accent-light] text-[--accent] text-[9px] font-black uppercase">
              <Link2 size={10} /> Linked
            </span>
          )}
        </span>
      ),
    },
    { key: 'businessType', label: 'Business Type', render: (r) => r.business_type || '-' },
    { key: 'contactPerson', label: 'Contact Person', render: (r) => r.contact_person || '-' },
    { key: 'phoneNumber', label: 'Mobile Number', render: (r) => <span className="font-mono font-bold text-[--text-primary]">{r.phone_number || '-'}</span> },
    { key: 'alternateNumber', label: 'Alternate Number', render: (r) => r.alternate_number || '-' },
    { key: 'city', label: 'City', render: (r) => r.city || '-' },
    { key: 'area', label: 'Area', render: (r) => r.area || '-' },
    { key: 'address', label: 'Address', render: renderAddress },
    { key: 'callStatus', label: 'Call Status', render: renderCallStatus },
    { key: 'customerResponse', label: 'Customer Response', render: (r) => <span className="truncate max-w-[180px] block" title={r.customer_response || ''}>{r.customer_response || '-'}</span> },
    { key: 'followUpRequired', label: 'Follow-up Required', render: (r) => r.follow_up_required || '-' },
    { key: 'followUpDate', label: 'Follow-up Date', render: (r) => fmtDate(r.follow_up_date || r.appointment_date) },
    { key: 'followUpTime', label: 'Follow-up Time', render: (r) => r.follow_up_time || r.appointment_timings || '-' },
    { key: 'nextAction', label: 'Next Action', render: (r) => <span className="truncate max-w-[160px] block" title={r.next_action || ''}>{r.next_action || '-'}</span> },
    { key: 'remarks', label: 'Remarks', render: (r) => <span className="truncate max-w-[180px] block" title={r.remarks || ''}>{r.remarks || '-'}</span> },
    { key: 'converted', label: 'Converted (Y/N)', render: renderConverted },
    { key: 'deliveryDate', label: 'Delivery Date', render: (r) => fmtDate(r.delivery_date) },
    { key: 'deliveryTime', label: 'Delivery Time', render: (r) => r.delivery_time || '-' },
  ],
  detailFields: [
    { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
    { key: 'employeeName', label: 'Employee Name', render: (r) => r.assignee_name || r.employee_name_raw || '-' },
    { key: 'businessType', label: 'Business Type', render: (r) => r.business_type || '-' },
    { key: 'businessName', label: 'Business Name', render: (r) => r.business_name || '-' },
    { key: 'contactPerson', label: 'Contact Person', render: (r) => r.contact_person || '-' },
    { key: 'phoneNumber', label: 'Mobile Number', render: (r) => r.phone_number || '-' },
    { key: 'alternateNumber', label: 'Alternate Number', render: (r) => r.alternate_number || '-' },
    { key: 'city', label: 'City', render: (r) => r.city || '-' },
    { key: 'area', label: 'Area', render: (r) => r.area || '-' },
    { key: 'address', label: 'Address', render: renderAddress },
    { key: 'callStatus', label: 'Call Status', render: renderCallStatus },
    { key: 'customerResponse', label: 'Customer Response', render: (r) => r.customer_response || '-' },
    { key: 'followUpRequired', label: 'Follow-up Required', render: (r) => r.follow_up_required || '-' },
    { key: 'followUpDate', label: 'Follow-up Date', render: (r) => fmtDate(r.follow_up_date || r.appointment_date) },
    { key: 'followUpTime', label: 'Follow-up Time', render: (r) => r.follow_up_time || r.appointment_timings || '-' },
    { key: 'nextAction', label: 'Next Action', render: (r) => r.next_action || '-' },
    { key: 'remarks', label: 'Remarks', render: (r) => r.remarks || '-' },
    { key: 'converted', label: 'Converted (Y/N)', render: renderConverted },
    { key: 'deliveryDate', label: 'Delivery Date', render: (r) => fmtDate(r.delivery_date) },
    { key: 'deliveryTime', label: 'Delivery Time', render: (r) => r.delivery_time || '-' },
  ],
  sortableColumns: ['date', 'businessName', 'city', 'deliveryDate', 'callStatus', 'followUpDate', 'converted'],
  endpoints: {
    list: '/api/v1/delivery-data',
    exportCsv: '/api/v1/delivery-data/export/csv',
  },
  filenamePrefix: 'delivery-data',
  ModalComponent: DeliveryDataModal,
  emptyStateText: 'No delivery data yet — add one or import a file.',
  hideSubVerticals: true,
};

export default function DeliveryDataPage() {
  return <DataSectionPage config={config} />;
}
