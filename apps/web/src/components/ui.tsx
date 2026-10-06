import type { ReactNode } from "react";
import { formatBps, TONE_LABEL, utilizationTone } from "../lib/format";

export type NoticeTone = "info" | "warn" | "danger" | "success" | "neutral";

export function Notice({ tone = "neutral", children, testid }: { tone?: NoticeTone; children: ReactNode; testid?: string }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === "danger" ? "alert" : undefined} data-testid={testid}>
      {children}
    </div>
  );
}

export function StatusChip({ utilizationBps, testid }: { utilizationBps: number; testid?: string }) {
  const tone = utilizationTone(utilizationBps);
  return (
    <span className={`chip chip--${tone}`} data-status={tone} data-testid={testid}>
      {TONE_LABEL[tone]}
    </span>
  );
}

export function Chip({ tone, children, testid }: { tone: "open" | "tight" | "frozen" | "neutral"; children: ReactNode; testid?: string }) {
  return (
    <span className={`chip chip--${tone}`} data-testid={testid}>
      {children}
    </span>
  );
}

export function UtilBar({ utilizationBps, testid }: { utilizationBps: number; testid?: string }) {
  const tone = utilizationTone(utilizationBps);
  return (
    <span className="util" data-bps={utilizationBps} data-testid={testid}>
      <span className="util-track" aria-hidden="true">
        <span className={`util-fill util-fill--${tone}`} style={{ width: `${Math.min(100, utilizationBps / 100)}%` }} />
      </span>
      <span className="mono">{formatBps(utilizationBps)}</span>
    </span>
  );
}

export function Stat({ label, value, testid, sub }: { label: string; value: ReactNode; testid?: string; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value mono" data-testid={testid}>
        {value}
      </div>
      {sub !== undefined && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export interface ToggleOption<T extends string> {
  value: T;
  label: ReactNode;
  testid?: string;
  disabled?: boolean;
}

/** Single-choice button group (tabs or pills), announced with aria-pressed. */
export function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
  label,
  variant = "pill",
}: {
  options: ToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  variant?: "pill" | "tab" | "dark";
}) {
  return (
    <div className="toggle-group" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`toggle toggle--${variant}`}
          aria-pressed={option.value === value}
          data-testid={option.testid}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SummaryRow({ label, children, testid }: { label: ReactNode; children: ReactNode; testid?: string }) {
  return (
    <div className="summary-row">
      <span className="summary-label">{label}</span>
      <span className="summary-value mono" data-testid={testid}>
        {children}
      </span>
    </div>
  );
}

/** The one number a panel is about (average discount, savings), shown large. */
export function Highlight({
  label,
  children,
  tone,
  testid,
}: {
  label: ReactNode;
  children: ReactNode;
  tone: "warn" | "good";
  testid?: string;
}) {
  return (
    <div className={`highlight highlight--${tone}`}>
      <span className="highlight-label">{label}</span>
      <span className="highlight-value mono" data-testid={testid}>
        {children}
      </span>
    </div>
  );
}
