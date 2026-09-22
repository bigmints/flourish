import * as React from "react";
import { cn } from "@/lib/utils";
import { Select as ShadcnSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => <input ref={ref} className={cn("flex h-11 w-full rounded-xl border border-input bg-background px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring disabled:opacity-50 md:text-sm", className)} {...props} />);
Input.displayName = "Input";

const emptySelectValue = "__flourish_empty__";

export const Select = React.forwardRef<HTMLButtonElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, value, defaultValue, onChange, disabled, required, name, id, ...props }, ref) => {
  const options = React.Children.toArray(children).filter(React.isValidElement).map((child) => {
    const option = child as React.ReactElement<React.OptionHTMLAttributes<HTMLOptionElement>>;
    const optionValue = String(option.props.value ?? "");
    return { value: optionValue || emptySelectValue, label: option.props.children, disabled: option.props.disabled };
  });
  const selectedValue = String(value ?? defaultValue ?? "") || emptySelectValue;

  return <ShadcnSelect
    value={selectedValue}
    onValueChange={(nextValue) => onChange?.({ target: { value: nextValue === emptySelectValue ? "" : nextValue } } as React.ChangeEvent<HTMLSelectElement>)}
    disabled={disabled}
    required={required}
    name={name}
  >
    <SelectTrigger ref={ref} id={id} className={cn("h-11 rounded-xl text-base md:text-sm", className)} aria-label={props["aria-label"]} aria-describedby={props["aria-describedby"]}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent>
  </ShadcnSelect>;
});
Select.displayName = "Select";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) { return <label className={cn("text-sm font-medium", className)} {...props} />; }
