import React, { useState, useEffect } from 'react';
import { X, Database } from 'lucide-react';
import toast from 'react-hot-toast';
import axios from '../api/axios.js';
import SearchableOperatorSelect from './SearchableOperatorSelect.jsx';
import CsvImportModal from './CsvImportModal.jsx';
import { extractErrorMessage } from '../utils/errorMessage.js';

const RAW_DATA_ENDPOINTS = {
  schema: () => '/api/v1/raw-data/schema',
  template: (verticalId, _leadType, format) => `/api/v1/raw-data/import-template?verticalId=${verticalId}${format === 'xlsx' ? '&format=xlsx' : ''}`,
  upload: () => '/api/v1/raw-data/upload',
  log: (batchId) => `/api/v1/raw-data/upload-logs/${batchId}`,
  failedRows: (batchId) => `/api/v1/raw-data/upload-logs/${batchId}/failed-rows`,
};

const emptyForm = {
  date: '',
  employeeName: '',
  subVerticalId: '',
  productService: '',
  leadName: '',
  contactPerson: '',
  phoneNumber: '',
  alternateNumber: '',
  city: '',
  area: '',
  mapLocation: '',
  callStatus: '',
  customerResponse: '',
  followUpRequired: '',
  followUpDate: '',
  followUpTime: '',
  nextAction: '',
  remarks: '',
  converted: '',
};

const FormField = ({ label, required, children, className = '' }) => (
  <div className={`flex flex-col gap-1.5 ${className}`}>
    <span className="text-[10px] font-black uppercase text-[--text-secondary]">
      {label}{required && ' *'}
    </span>
    {children}
  </div>
);

/**
 * "Raw Data" feature entry point — Single Add + Bulk Upload.
 */
export default function RawDataModal({
  open,
  onClose,
  vertical,
  subVerticals = [],
  defaultSubVerticalId = '',
  agents = [],
  onSaved,
  initialMode = 'single',
  record
}) {
  const [mode, setMode] = useState(initialMode); // 'single' | 'bulk'
  const [form, setForm] = useState(emptyForm);
  const [assignedTo, setAssignedTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState([]);

  useEffect(() => {
    if (open) {
      if (record) {
        setMode('single');
        setForm({
          date: record.date ? record.date.slice(0, 10) : '',
          subVerticalId: record.subVerticalId?._id || record.subVerticalId || record.sub_vertical_id || '',
          productService: record.product_service || record.productService || record.business_type || '',
          leadName: record.lead_name || record.leadName || record.business_name || '',
          contactPerson: record.contactPerson || record.contact_person || '',
          phoneNumber: record.phoneNumber || record.phone_number || '',
          alternateNumber: record.alternateNumber || record.alternate_number || '',
          city: record.city || '',
          area: record.area || '',
          mapLocation: record.mapLocation || record.map_location || record.address || '',
          callStatus: record.callStatus || record.call_status || '',
          customerResponse: record.customerResponse || record.customer_response || '',
          followUpRequired: record.followUpRequired || record.follow_up_required || '',
          followUpDate: record.follow_up_date || record.followUpDate || record.appointment_date 
            ? String(record.follow_up_date || record.followUpDate || record.appointment_date).slice(0, 10) 
            : '',
          followUpTime: record.followUpTime || record.follow_up_time || record.appointment_timings || '',
          nextAction: record.nextAction || record.next_action || '',
          remarks: record.remarks || '',
          converted: record.converted || '',
        });
        const matchedAgent = agents.find(
          (a) => (a.id || a._id) === (record.assigned_user_id || record.assignedTo) ||
                 a.name === record.assignee_name ||
                 a.name === record.employee_name_raw
        );
        setAssignedTo(matchedAgent ? (matchedAgent.id || matchedAgent._id) : '');
      } else {
        setMode(initialMode);
        setForm((prev) => ({
          ...emptyForm,
          subVerticalId: defaultSubVerticalId || (subVerticals.length === 1 ? subVerticals[0]._id : ''),
        }));
        setAssignedTo('');
      }
      setFieldErrors([]);
    }
  }, [open, initialMode, defaultSubVerticalId, subVerticals, record, agents]);

  if (!open) return null;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleClose = () => {
    setForm(emptyForm);
    setAssignedTo('');
    setFieldErrors([]);
    setMode('single');
    onClose?.();
  };

  const selectedAgentName = agents.find((a) => (a.id || a._id) === assignedTo)?.name || '';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFieldErrors([]);
    try {
      const payload = {
        verticalId: vertical._id,
        ...form,
        subVerticalId: form.subVerticalId || undefined,
        employeeName: selectedAgentName,
      };
      let res;
      if (record) {
        res = await axios.patch(`/api/v1/raw-data/${record.id || record._id}`, payload);
        toast.success('Raw data record updated successfully.');
      } else {
        res = await axios.post('/api/v1/raw-data', payload);
        toast.success('Raw data record saved successfully.');
      }
      if (res.data.warnings?.length) {
        res.data.warnings.forEach((w) => toast(w.message, { icon: '⚠️' }));
      }
      onSaved?.();
      handleClose();
    } catch (err) {
      const fields = err.response?.data?.error?.fields || err.response?.data?.errors;
      if (fields?.length) {
        setFieldErrors(fields);
      } else {
        toast.error(extractErrorMessage(err, 'Failed to save raw data record'));
      }
    } finally {
      setSaving(false);
    }
  };

  if (mode === 'bulk') {
    return (
      <CsvImportModal
        open
        onClose={handleClose}
        vertical={vertical}
        subVerticals={subVerticals}
        defaultSubVerticalId={form.subVerticalId || defaultSubVerticalId}
        agents={agents}
        endpoints={RAW_DATA_ENDPOINTS}
        showSubVertical={subVerticals && subVerticals.length > 0}
        showAssignOperator={false}
        filenamePrefix="raw-data"
        title="Bulk Upload Raw Data"
        onImportComplete={onSaved}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm p-4">
      <div className="glass-panel w-full max-w-3xl p-6 bg-white border border-[--border] text-[--text-primary] shadow-xl rounded-xl space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-[--border] pb-3">
          <h3 className="text-lg font-bold text-[--text-primary] flex items-center gap-2">
            <Database className="text-[--accent]" size={20} />
            <span>{record ? 'Edit Raw Data Record' : 'Add Raw Data Record'}</span>
          </h3>
          <button onClick={handleClose} className="p-1 border border-[--border-strong] rounded text-[--text-secondary] hover:bg-stone-50">
            <X size={16} />
          </button>
        </div>

        {!record && (
          <div className="flex gap-2 border-b border-[--border] pb-3">
            <button
              type="button"
              onClick={() => setMode('single')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold ${mode === 'single' ? 'bg-[--accent] text-white' : 'bg-stone-100 text-[--text-secondary]'}`}
            >
              Single Add
            </button>
            <button
              type="button"
              onClick={() => setMode('bulk')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold ${mode === 'bulk' ? 'bg-[--accent] text-white' : 'bg-stone-100 text-[--text-secondary]'}`}
            >
              Bulk Upload
            </button>
          </div>
        )}

        {fieldErrors.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-600 space-y-1">
            {fieldErrors.map((err, idx) => (
              <div key={idx}>{err.message}</div>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <FormField label="Date">
              <input type="date" className="w-full" value={form.date} onChange={set('date')} />
            </FormField>

            <FormField label="Employee Name">
              <SearchableOperatorSelect agents={agents} value={assignedTo} onChange={setAssignedTo} placeholder="-- Select employee --" />
            </FormField>

            {subVerticals.length > 0 && (
              <FormField label="Sub-Vertical">
                <select className="w-full" value={form.subVerticalId} onChange={set('subVerticalId')}>
                  <option value="">-- Select Sub-Vertical (Optional) --</option>
                  {subVerticals.map((sv) => (
                    <option key={sv._id} value={sv._id}>{sv.name}</option>
                  ))}
                </select>
              </FormField>
            )}

            <FormField label="Product/Service">
              <input type="text" placeholder="e.g. Software, Consulting" className="w-full" value={form.productService} onChange={set('productService')} />
            </FormField>

            <FormField label="Lead Name">
              <input type="text" placeholder="e.g. Acme Enterprises" className="w-full" value={form.leadName} onChange={set('leadName')} />
            </FormField>

            <FormField label="Contact Person">
              <input type="text" placeholder="e.g. John Doe" className="w-full" value={form.contactPerson} onChange={set('contactPerson')} />
            </FormField>

            <FormField label="Mobile Number" required>
              <input type="text" required placeholder="Mandatory (Primary Key)" className="w-full font-medium" value={form.phoneNumber} onChange={set('phoneNumber')} />
            </FormField>

            <FormField label="Alternate Number(If Any)">
              <input type="text" placeholder="Alternate phone" className="w-full" value={form.alternateNumber} onChange={set('alternateNumber')} />
            </FormField>

            <FormField label="City">
              <input type="text" placeholder="e.g. Bengaluru" className="w-full" value={form.city} onChange={set('city')} />
            </FormField>

            <FormField label="Area">
              <input type="text" placeholder="e.g. Whitefield" className="w-full" value={form.area} onChange={set('area')} />
            </FormField>

            <FormField label="Map Location">
              <input type="text" placeholder="https://maps.google.com/?q=..." className="w-full" value={form.mapLocation} onChange={set('mapLocation')} />
            </FormField>

            <FormField label="Call Status">
              <select className="w-full" value={form.callStatus} onChange={set('callStatus')}>
                <option value="">-- Select Status --</option>
                <option value="Connected">Connected</option>
                <option value="Busy">Busy</option>
                <option value="Not Reachable">Not Reachable</option>
                <option value="Switched Off">Switched Off</option>
                <option value="Callback Requested">Callback Requested</option>
                <option value="Wrong Number">Wrong Number</option>
                <option value="Disconnected">Disconnected</option>
              </select>
            </FormField>

            <FormField label="Customer Response">
              <input type="text" placeholder="Customer's feedback/reaction" className="w-full" value={form.customerResponse} onChange={set('customerResponse')} />
            </FormField>

            <FormField label="Follow-up Required">
              <select className="w-full" value={form.followUpRequired} onChange={set('followUpRequired')}>
                <option value="">-- Select --</option>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </FormField>

            <FormField label="Follow-up Date">
              <input type="date" className="w-full" value={form.followUpDate} onChange={set('followUpDate')} />
            </FormField>

            <FormField label="Follow-up Time">
              <input type="text" placeholder="e.g. 11:00 AM" className="w-full" value={form.followUpTime} onChange={set('followUpTime')} />
            </FormField>

            <FormField label="Next Action">
              <input type="text" placeholder="e.g. Send brochure / Demo" className="w-full" value={form.nextAction} onChange={set('nextAction')} />
            </FormField>

            <FormField label="Converted (Y/N)">
              <select className="w-full" value={form.converted} onChange={set('converted')}>
                <option value="">-- Select --</option>
                <option value="Y">Y</option>
                <option value="N">N</option>
              </select>
            </FormField>
          </div>

          <FormField label="Remarks">
            <textarea className="w-full" rows={3} maxLength={500} placeholder="Additional notes or remarks..." value={form.remarks} onChange={set('remarks')} />
          </FormField>

          <div className="flex justify-end gap-2 pt-2 border-t border-[--border]">
            <button type="button" onClick={handleClose} className="px-4 py-2 border border-[--border-strong] rounded-lg text-sm text-[--text-secondary] font-semibold bg-white hover:bg-stone-50">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-[--accent] text-white rounded-lg font-bold text-sm hover:bg-[--accent-hover] shadow-sm disabled:opacity-40">
              {saving ? 'Saving...' : 'Save Raw Data'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
