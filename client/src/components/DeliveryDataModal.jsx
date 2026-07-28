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
  date: '', employeeName: '', businessType: '', businessName: '', area: '', city: '',
  phoneNumber: '', address: '', appointmentDate: '', appointmentTimings: '', remarks: '',
  deliveryDate: '', deliveryTime: '',
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
export default function DeliveryDataModal({ open, onClose, vertical, agents = [], onSaved, initialMode = 'single' }) {
  const [mode, setMode] = useState(initialMode); // 'single' | 'bulk'
  const [form, setForm] = useState(emptyForm);
  const [assignedTo, setAssignedTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState([]);

  // Re-apply initialMode each time the modal opens — a single mounted
  // instance is reused for both "Add" (initialMode="single") and "Import"
  // (initialMode="bulk") toolbar buttons in DataSectionPage.
  useEffect(() => {
    if (open) setMode(initialMode);
  }, [open, initialMode]);

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
      const res = await axios.post('/api/v1/delivery-data', {
        verticalId: vertical._id,
        ...form,
        employeeName: selectedAgentName,
      });
      if (res.data.warnings?.length) {
        res.data.warnings.forEach((w) => toast(w.message, { icon: '⚠️' }));
      }
      toast.success('Delivery data record saved.');
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
      <div className="glass-panel w-full max-w-2xl p-6 bg-white border border-[--border] text-[--text-primary] shadow-xl rounded-xl space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-[--border] pb-3">
          <h3 className="text-lg font-bold text-[--text-primary] flex items-center gap-2">
            <Truck className="text-[--accent]" size={20} />
            <span>Add Delivery Data</span>
          </h3>
          <button onClick={handleClose} className="p-1 border border-[--border-strong] rounded text-[--text-secondary] hover:bg-stone-50">
            <X size={16} />
          </button>
        </div>

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

        {fieldErrors.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-600 space-y-1">
            {fieldErrors.map((err, idx) => (
              <div key={idx}>{err.message}</div>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField label="Date" required>
              <input type="date" required className="w-full" value={form.date} onChange={set('date')} />
            </FormField>
            <FormField label="Employee Name" required>
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
            <FormField label="Business Name" required>
              <input type="text" required className="w-full" value={form.businessName} onChange={set('businessName')} />
            </FormField>
            <FormField label="Area">
              <input type="text" placeholder="-" className="w-full" value={form.area} onChange={set('area')} />
            </FormField>
            <FormField label="City">
              <input type="text" placeholder="-" className="w-full" value={form.city} onChange={set('city')} />
            </FormField>
            <FormField label="Phone Number" required>
              <input type="text" required className="w-full" value={form.phoneNumber} onChange={set('phoneNumber')} />
            </FormField>
            <FormField label="Address">
              <input type="text" placeholder="-" className="w-full" value={form.address} onChange={set('address')} />
            </FormField>
            <FormField label="Appointment Date">
              <input type="date" className="w-full" value={form.appointmentDate} onChange={set('appointmentDate')} />
            </FormField>
            <FormField label="Appointment Timings">
              <input type="text" placeholder="e.g. 10:00 AM - 11:00 AM" className="w-full" value={form.appointmentTimings} onChange={set('appointmentTimings')} />
            </FormField>
            <FormField label="Delivery Date" required>
              <input type="date" required className="w-full" value={form.deliveryDate} onChange={set('deliveryDate')} />
            </FormField>
            <FormField label="Delivery Time" required>
              <input type="text" required placeholder="e.g. 2:00 PM - 3:00 PM" className="w-full" value={form.deliveryTime} onChange={set('deliveryTime')} />
            </FormField>
          </div>
          <FormField label="Remarks">
            <textarea className="w-full" rows={3} maxLength={500} value={form.remarks} onChange={set('remarks')} />
          </FormField>

          <div className="flex justify-end gap-2 pt-2 border-t border-[--border]">
            <button type="button" onClick={handleClose} className="px-4 py-2 border border-[--border-strong] rounded-lg text-sm text-[--text-secondary] font-semibold bg-white hover:bg-stone-50">
              Cancel
            </button>
            <button type="submit" disabled={saving || !assignedTo} className="px-4 py-2 bg-[--accent] text-white rounded-lg font-bold text-sm hover:bg-[--accent-hover] shadow-sm disabled:opacity-40">
              {saving ? 'Saving...' : 'Save Delivery Data'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
