import * as RadioGroup from "@radix-ui/react-radio-group";
import { useId } from "react";
import "./ui.css";

export function Choices({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <RadioGroup.Root
      className="choice-list"
      name={id}
      aria-label={label}
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      orientation="vertical"
    >
      {options.map((option, index) => (
        <div className="choice-option" key={option.value}>
          <RadioGroup.Item
            className="choice-control"
            value={option.value}
            id={`${id}-${index}`}
          >
            <RadioGroup.Indicator className="choice-indicator" />
          </RadioGroup.Item>
          <label htmlFor={`${id}-${index}`}>{option.label}</label>
        </div>
      ))}
    </RadioGroup.Root>
  );
}
