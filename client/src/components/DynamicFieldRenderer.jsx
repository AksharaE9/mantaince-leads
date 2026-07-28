import React from 'react';
import { Controller } from 'react-hook-form';
import { format } from 'date-fns';

/**
 * Dynamic Field Renderer
 * Formats custom vertical fields for visual table display, or registers react-hook-form Controllers in edit mode.
 */
export const DynamicFieldRenderer = ({ fields = [], mode = 'view', control, errors = {}, values = {} }) => {
  
  const renderViewValue = (cfg) => {
    const raw = values[cfg.fieldKey];
    if (raw === undefined || raw === null || raw === '') {
      return <span className="text-[--text-muted] italic">N/A</span>;
    }

    switch (cfg.fieldType) {
      case 'boolean':
        return raw ? (
          <span className="text-[#2ecc71] font-semibold bg-[#2ecc71]/10 px-2 py-0.5 rounded border border-[#2ecc71]/20">Yes</span>
        ) : (
          <span className="text-red-500 font-semibold bg-red-50 px-2 py-0.5 rounded border border-red-200">No</span>
        );
      case 'url':
        return (
          <a href={raw} target="_blank" rel="noopener noreferrer" className="text-[--accent] hover:underline break-all">
            {raw}
          </a>
        );
      case 'date':
        try {
          return <span>{format(new Date(raw), 'dd-MMM-yyyy')}</span>;
        } catch {
          return <span>{String(raw)}</span>;
        }
      case 'multiselect': {
        const arr = Array.isArray(raw) ? raw : String(raw).split(',').map(s => s.trim());
        return (
          <div className="flex flex-wrap gap-1">
            {arr.map((item, idx) => (
              <span key={idx} className="bg-stone-50 border border-[--border] px-1.5 py-0.5 rounded text-[10px] text-[--text-secondary] font-semibold">
                {item}
              </span>
            ))}
          </div>
        );
      }
      default:
        return <span>{String(raw)}</span>;
    }
  };

  if (fields.length === 0) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {fields.map((cfg) => {
        const hasError = errors[cfg.fieldKey];

        return (
          <div key={cfg._id} className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-[--text-secondary] uppercase">
              {cfg.label} {cfg.isRequired && <span className="text-red-500">*</span>}
            </label>

            {mode === 'view' ? (
              <div className="bg-stone-50 border border-[--border] rounded-lg px-4 py-2 text-[--text-primary] min-h-[40px] flex items-center">
                {renderViewValue(cfg)}
              </div>
            ) : (
              // Edit Mode: react-hook-form Controller integration
              <Controller
                name={`data.${cfg.fieldKey}`}
                control={control}
                defaultValue={values[cfg.fieldKey] ?? cfg.defaultValue ?? ''}
                rules={{
                  required: cfg.isRequired ? `${cfg.label} is required` : false,
                  validate: (val) => {
                    if (cfg.validationRegex && val) {
                      try {
                        const rx = new RegExp(cfg.validationRegex);
                        if (!rx.test(val.toString())) {
                          return cfg.validationMessage || `Invalid format for ${cfg.label}`;
                        }
                      } catch {
                        // ignore invalid regex configs
                      }
                    }
                    return true;
                  }
                }}
                render={({ field }) => {
                  switch (cfg.fieldType) {
                    case 'textarea':
                      return (
                        <textarea
                          {...field}
                          rows={3}
                          className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                          placeholder={cfg.placeholder}
                        />
                      );
                    case 'select':
                      return (
                        <select
                          {...field}
                          className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                        >
                          <option value="">-- Choose Option --</option>
                          {cfg.options?.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      );
                    case 'multiselect': {
                      // Custom multi-select checkbox group
                      const activeValues = Array.isArray(field.value) ? field.value : [];
                      const handleCheckboxChange = (opt) => {
                        const nextVal = activeValues.includes(opt)
                          ? activeValues.filter(v => v !== opt)
                          : [...activeValues, opt];
                        field.onChange(nextVal);
                      };
                      return (
                        <div className="grid grid-cols-2 gap-2 bg-[--bg-input] p-2 rounded-lg border border-[--border-strong] max-h-[120px] overflow-y-auto">
                          {cfg.options?.map(opt => {
                            const isChecked = activeValues.includes(opt);
                            return (
                              <label key={opt} className="flex items-center gap-2 text-xs text-[--text-secondary] cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => handleCheckboxChange(opt)}
                                  className="w-4 h-4 accent-[--accent]"
                                />
                                <span>{opt}</span>
                              </label>
                            );
                          })}
                        </div>
                      );
                    }
                    case 'boolean':
                      return (
                        <label className="flex items-center gap-2 cursor-pointer py-1.5 select-none">
                          <input
                            type="checkbox"
                            checked={!!field.value}
                            onChange={(e) => field.onChange(e.target.checked)}
                            className="w-5 h-5 accent-[--accent]"
                          />
                          <span className="text-sm text-[--text-primary]">{cfg.placeholder || 'Enable Option'}</span>
                        </label>
                      );
                    case 'date': {
                      // Format date value to yyyy-MM-dd for HTML input
                      let dateStr = field.value;
                      if (dateStr instanceof Date) {
                        dateStr = dateStr.toISOString().split('T')[0];
                      } else if (dateStr) {
                        try {
                          dateStr = new Date(dateStr).toISOString().split('T')[0];
                        } catch {
                          dateStr = '';
                        }
                      }
                      return (
                        <input
                          type="date"
                          className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                          value={dateStr || ''}
                          onChange={(e) => field.onChange(e.target.value)}
                        />
                      );
                    }
                    case 'number':
                      return (
                        <input
                          type="number"
                          {...field}
                          className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                          placeholder={cfg.placeholder}
                          onChange={(e) => field.onChange(e.target.value === '' ? '' : Number(e.target.value))}
                        />
                      );
                    default:
                      return (
                        <input
                          type={cfg.fieldType === 'email' ? 'email' : cfg.fieldType === 'url' ? 'url' : 'text'}
                          {...field}
                          className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                          placeholder={cfg.placeholder}
                        />
                      );
                  }
                }}
              />
            )}

            {hasError && (
              <span className="text-red-500 text-xs font-semibold">
                {hasError.message || 'Required field'}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default DynamicFieldRenderer;
