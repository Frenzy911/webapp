import type { InputHTMLAttributes } from 'react';

type Props = {
  name: string;
  label: string;
  value?: string;
  errors?: Record<string, string>;
  hint?: string;
  type?: string;
  rows?: number;
  options?: [string, string][];
  /** Extra attributes for the input (autocomplete, inputMode, maxLength, …). */
  input?: InputHTMLAttributes<HTMLInputElement>;
};

/**
 * A labelled form field with its hint and error, wired up for screen readers
 * (aria-describedby, aria-invalid). Uncontrolled: the value is the default value.
 */
export function Field({ name, label, value = '', errors = {}, hint, type = 'text', rows = 5, options = [], input = {} }: Props) {
  const id = `f-${name}`;
  const err = errors[name];
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = err ? `${id}-error` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  const common = { id, name, 'aria-describedby': describedBy, 'aria-invalid': err ? true : undefined };

  return (
    <div className={`field${err ? ' has-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      )}
      {type === 'textarea' ? (
        <textarea {...common} rows={rows} defaultValue={value} key={value} />
      ) : type === 'select' ? (
        <select {...common} defaultValue={value} key={value}>
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      ) : (
        <input {...common} type={type} defaultValue={value} key={value} {...input} />
      )}
      {err && (
        <p className="field-error" id={errId}>
          <span aria-hidden="true">⚠ </span>
          {err}
        </p>
      )}
    </div>
  );
}
