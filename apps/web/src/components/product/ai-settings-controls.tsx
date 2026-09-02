import { WarningCircleIcon } from "@phosphor-icons/react";

export function SettingsChoice<Value extends string>({
  checked,
  detail,
  disabled,
  group,
  label,
  onChange,
  tag,
  value
}: Readonly<{
  checked: boolean;
  detail: string;
  disabled: boolean;
  group: string;
  label: string;
  onChange: (value: Value) => void;
  tag?: string;
  value: Value;
}>) {
  return (
    <label className="ai-choice" data-selected={checked} data-disabled={disabled}>
      <input
        type="radio"
        name={group}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
      />
      <span>
        <strong>
          {label}
          {tag === undefined ? null : <em className="ai-choice-tag">{tag}</em>}
        </strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

export function SettingsNotice({
  message,
  tone
}: Readonly<{ message: string; tone: "alert" | "status" }>) {
  return (
    <div className="ai-settings-notice" role={tone} data-tone={tone}>
      <WarningCircleIcon size={18} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

export function AiSettingsSkeleton({ label }: Readonly<{ label: string }>) {
  return (
    <div className="ai-settings-skeleton" aria-busy="true" aria-label={label}>
      <div className="skeleton-block h-4 w-28" />
      <div className="skeleton-block mt-4 h-8 w-72 max-w-[80%]" />
      <div className="ai-settings-skeleton-grid">
        {[0, 1, 2].map((row) => (
          <div className="skeleton-block h-24" key={row} aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}
