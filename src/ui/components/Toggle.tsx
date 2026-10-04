import './Toggle.css';

/** An on/off setting, drawn as a switch so it never reads as an action. */
export function Toggle({
  checked,
  onChange,
  label,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="toggle"
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__knob" />
      </span>
      <span className="toggle__label">{label}</span>
    </button>
  );
}
