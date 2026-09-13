import * as RadioGroup from "@radix-ui/react-radio-group";
import { useId } from "react";

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
      className="flex flex-col gap-2"
      name={id}
      aria-label={label}
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      orientation="vertical"
    >
      {options.map((option, index) => (
        <div className="flex items-center gap-2" key={option.value}>
          <RadioGroup.Item
            className="grid place-items-center size-[14px] p-0 border border-line-interactive rounded-full bg-app cursor-pointer data-[state=checked]:border-line-focus disabled:opacity-50 disabled:cursor-not-allowed"
            value={option.value}
            id={`${id}-${index}`}
          >
            <RadioGroup.Indicator className="size-2 rounded-full bg-line-focus" />
          </RadioGroup.Item>
          <label htmlFor={`${id}-${index}`}>{option.label}</label>
        </div>
      ))}
    </RadioGroup.Root>
  );
}
