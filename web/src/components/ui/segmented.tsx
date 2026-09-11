import "@/components/ui/ui.css";

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="segmented">
      <legend className="visually-hidden">{label}</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segment"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
