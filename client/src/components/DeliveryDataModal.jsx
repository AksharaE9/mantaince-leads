import React, { useState, useEffect } from 'react';
import { X, Truck } from 'lucide-react';
import toast from 'react-hot-toast';
import axios from '../api/axios.js';
import SearchableOperatorSelect from './SearchableOperatorSelect.jsx';
import CsvImportModal from './CsvImportModal.jsx';
import { extractErrorMessage } from '../utils/errorMessage.js';

const DELIVERY_DATA_ENDPOINTS = {
  schema: () => '/api/v1/delivery-data/schema',
  template: (verticalId, _leadType, format) => `/api/v1/delivery-data/import-template?verticalId=${verticalId}${format === 'xlsx' ? '&format=xlsx' : ''}`,
  upload: () => '/api/v1/delivery-data/upload',
  log: (batchId) => `/api/v1/delivery-data/upload-logs/${batchId}`,
  failedRows: (batchId) => `/api/v1/delivery-data/upload-logs/${batchId}/failed-rows`,
};

const emptyForm = {
  date: '', employeeName: '', businessType: '', businessName: '', contactPerson: '',
  phoneNumber: '', alternateNumber: '', city: '', area: '', address: '',
  callStatus: '', customerResponse: '', followUpRequired: '', followUpDate: '',
  followUpTime: '', nextAction: '', remarks: '', converted: '',
  appointmentDate: '', appointmentTimings: '', deliveryDate: '', deliveryTime: '',
};

const FormField = ({ label, required, children }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-[10px] font-black uppercase text-[--text-secondary]">
      {label}{required && ' *'}
    </span>
    {children}
  </div>
);

/**
 * "Delivery Data" feature entry point — Single Add + Bulk Upload (via the
 * shared CsvImportModal, reconfigured with delivery-data endpoints). Mirrors
 * RawDataModal.jsx's structure exactly, plus Delivery Date/Delivery Time.
 * Vertical is always the `vertical` prop (closure state from LeadsPage),
 * never a field on this form — matching how Raw Data/Add Lead are scoped.
 *
 * Delivery Data is an independent sibling of Raw Data (own table, own
 * endpoints) — it is not merged into Raw Data's form or table.
 */
export default function DeliveryDataModal({ open, onClose, vertical, agents = [], onSaved, initialMode = 'single', record }) {
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
          businessType: record.business_type || record.businessType || '',
          businessName: record.business_name || record.businessName || '',
          contactPerson: record.contact_person || record.contactPerson || '',
          phoneNumber: record.phone_number || record.phoneNumber || '',
          alternateNumber: record.alternate_number || record.alternateNumber || '',
          city: record.city || '',
          area: record.area || '',
          address: record.address || '',
          callStatus: record.call_status || record.callStatus || '',
          customerResponse: record.customer_response || record.customerResponse || '',
          followUpRequired: record.follow_up_required || record.followUpRequired || '',
          followUpDate: record.follow_up_date || record.followUpDate || record.appointment_date 
            ? String(record.follow_up_date || record.followUpDate || record.appointment_date).slice(0, 10) 
            : '',
          followUpTime: record.follow_up_time || record.followUpTime || record.appointment_timings || '',
          nextAction: record.next_action || record.nextAction || '',
          remarks: record.remarks || '',
          converted: record.converted || '',
          deliveryDate: record.delivery_date || record.deliveryDate 
            ? String(record.delivery_date || record.deliveryDate).slice(0, 10) 
            : '',
          deliveryTime: record.delivery_time || record.deliveryTime || '',
        });
        const matchedAgent = agents.find(
          (a) => (a.id || a._id) === (record.assigned_user_id || record.assignedTo) ||
                 a.name === record.assignee_name ||
                 a.name === record.employee_name_raw
        );
        setAssignedTo(matchedAgent ? (matchedAgent.id || matchedAgent._id) : '');
      } else {
        setMode(initialMode);
        setForm(emptyForm);
        setAssignedTo('');
      }
      setFieldErrors([]);
    }
  }, [open, initialMode, record, agents]);

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
        employeeName: selectedAgentName,
      };
      let res;
      if (record) {
        res = await axios.patch(`/api/v1/delivery-data/${record.id || record._id}`, payload);
        toast.success('Delivery data record updated.');
      } else {
        res = await axios.post('/api/v1/delivery-data', payload);
        toast.success('Delivery data record saved.');
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
        toast.error(extractErrorMessage(err, 'Failed to save delivery data record'));
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
        agents={agents}
        endpoints={DELIVERY_DATA_ENDPOINTS}
        showSubVertical={false}
        showAssignOperator={false}
        filenamePrefix="delivery-data"
        title="Bulk Upload Delivery Data"
        onImportComplete={onSaved}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm p-4">
      <div className="glass-panel w-full max-w-3xl p-6 bg-white border border-[--border] text-[--text-primary] shadow-xl rounded-xl space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-[--border] pb-3">
          <h3 className="text-lg font-bold text-[--text-primary] flex items-center gap-2">
            <Truck className="text-[--accent]" size={20} />
            <span>{record ? 'Edit Delivery Data' : 'Add Delivery Data'}</span>
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField label="Date">
              <input type="date" className="w-full" value={form.date} onChange={set('date')} />
            </FormField>
            <FormField label="Employee Name">
              <SearchableOperatorSelect agents={agents} value={assignedTo} onChange={setAssignedTo} placeholder="-- Select employee --" />
            </FormField>
            <FormField label="Business Type">
              <input type="text" className="w-full" value={form.businessType} onChange={set('businessType')} list="delivery-business-type-suggestions" />
              <datalist id="delivery-business-type-suggestions">
                <option value="Retail" />
                <option value="Wholesale" />
                <option value="Manufacturing" />
                <option value="Services" />
              </datalist>
            </FormField>
            <FormField label="Business Name">
              <input type="text" placeholder="-" className="w-full" value={form.businessName} onChange={set('businessName')} />
            </FormField>
            <FormField label="Contact Person">
              <input type="text" placeholder="-" className="w-full" value={form.contactPerson} onChange={set('contactPerson')} />
            </FormField>
            <FormField label="Mobile Number" required>
              <input type="text" required className="w-full" value={form.phoneNumber} onChange={set('phoneNumber')} />
            </FormField>
            <FormField label="Alternate Number">
              <input type="text" placeholder="-" className="w-full" value={form.alternateNumber} onChange={set('alternateNumber')} />
            </FormField>
            <FormField label="City">
              <input type="text" placeholder="-" className="w-full" value={form.city} onChange={set('city')} />
            </FormField>
            <FormField label="Area">
              <input type="text" placeholder="-" className="w-full" value={form.area} onChange={set('area')} />
            </FormField>
            <FormField label="Address / Map Location">
              <input type="text" placeholder="-" className="w-full" value={form.address} onChange={set('address')} />
            </FormField>
            <FormField label="Call Status">
              <select className="w-full" value={form.callStatus} onChange={set('callStatus')}>
                <option value="">-- Select --</option>
                <option value="Connected">Connected</option>
                <option value="Busy">Busy</option>
                <option value="Not Reachable">Not Reachable</option>
                <option value="Switched Off">Switched Off</option>
                <option value="Callback Requested">Callback Requested</option>
                <option value="Wrong Number">Wrong Number</option>
                <option value="Disconnected">Disconnected</option>
              </select>
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
              <input type="text" placeholder="e.g. 10:00 AM - 11:00 AM" className="w-full" value={form.followUpTime} onChange={set('followUpTime')} />
            </FormField>
            <FormField label="Appointment Date">
              <input type="date" className="w-full" value={form.appointmentDate} onChange={set('appointmentDate')} />
            </FormField>
            <FormField label="Appointment Timings">
              <input type="text" placeholder="e.g. 10:00 AM - 11:00 AM" className="w-full" value={form.appointmentTimings} onChange={set('appointmentTimings')} />
            </FormField>
            <FormField label="Next Action">
              <input type="text" placeholder="-" className="w-full" value={form.nextAction} onChange={set('nextAction')} />
            </FormField>
            <FormField label="Converted (Y/N)">
              <select className="w-full" value={form.converted} onChange={set('converted')}>
                <option value="">-- Select --</option>
                <option value="Y">Y</option>
                <option value="N">N</option>
              </select>
            </FormField>
            <FormField label="Delivery Date">
              <input type="date" className="w-full" value={form.deliveryDate} onChange={set('deliveryDate')} />
            </FormField>
            <FormField label="Delivery Time">
              <input type="text" placeholder="e.g. 2:00 PM - 3:00 PM" className="w-full" value={form.deliveryTime} onChange={set('deliveryTime')} />
            </FormField>
          </div>
          <FormField label="Customer Response">
            <textarea className="w-full" rows={2} value={form.customerResponse} onChange={set('customerResponse')} />
          </FormField>
          <FormField label="Remarks">
            <textarea className="w-full" rows={3} maxLength={500} value={form.remarks} onChange={set('remarks')} />
          </FormField>

          <div className="flex justify-end gap-2 pt-2 border-t border-[--border]">
            <button type="button" onClick={handleClose} className="px-4 py-2 border border-[--border-strong] rounded-lg text-sm text-[--text-secondary] font-semibold bg-white hover:bg-stone-50">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-[--accent] text-white rounded-lg font-bold text-sm hover:bg-[--accent-hover] shadow-sm disabled:opacity-40">
              {saving ? 'Saving...' : 'Save Delivery Data'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
