import type { ReactNode } from "react";

/** Labelled decimal text input; parsing and validation stay with the caller. */
export function AmountField({
  id,
  label,
  value,
  onChange,
  onMax,
  hint,
  error,
  testid,
  suffix,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  onMax?: () => void;
  hint?: ReactNode;
  error?: string | null;
  testid: string;
  suffix?: string;
}) {
  const invalid = !!error;
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="input-row">
        <input
          id={id}
          className="input input--mono"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={`${id}-hint`}
          data-testid={testid}
        />
        {suffix && <span className="input-suffix">{suffix}</span>}
        {onMax && (
          <button type="button" className="btn btn--secondary" onClick={onMax} data-testid={`${testid}-max`}>
            Max
          </button>
        )}
      </div>
      <span id={`${id}-hint`} className={invalid ? "hint text-bad" : "hint"}>
        {invalid ? error : hint}
      </span>
    </div>
  );
}
