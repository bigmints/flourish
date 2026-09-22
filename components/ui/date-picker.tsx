"use client";

import * as React from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function parseDate(value?: string) {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day);
}

function dateValue(value: Date) {
  return format(value, "yyyy-MM-dd");
}

function parseMonth(value?: string) {
  if (!value) return undefined;
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return undefined;
  return new Date(year, month - 1, 1);
}

function monthValue(value: Date) {
  return format(value, "yyyy-MM");
}

type PickerProps = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  required?: boolean;
  min?: string;
  "aria-label"?: string;
};

export function DatePicker({ id, value, onChange, placeholder = "Pick a date", className, required, min, "aria-label": ariaLabel }: PickerProps) {
  const selected = parseDate(value);
  const minimum = parseDate(min);
  const [open, setOpen] = React.useState(false);

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button id={id} type="button" variant="outline" aria-label={ariaLabel} className={cn("w-full justify-start px-3 text-left font-normal", !value && "text-muted-foreground", className)}>
        <CalendarDays className="h-4 w-4" />
        {selected ? format(selected, "d MMM yyyy") : placeholder}
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-auto p-0" align="start">
      <Calendar mode="single" selected={selected} defaultMonth={selected} onSelect={(date) => { if (date) { onChange(dateValue(date)); setOpen(false); } }} disabled={minimum ? { before: minimum } : undefined} />
      {!required && value && <div className="border-t p-2"><Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => { onChange(""); setOpen(false); }}>Clear date</Button></div>}
    </PopoverContent>
  </Popover>;
}

export function MonthPicker({ id, value, onChange, placeholder = "Pick a month", className, required, min, "aria-label": ariaLabel }: PickerProps) {
  const selected = parseMonth(value);
  const minimum = parseMonth(min);
  const [visibleYear, setVisibleYear] = React.useState(selected?.getFullYear() ?? new Date().getFullYear());
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (selected) setVisibleYear(selected.getFullYear());
  }, [value]);

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button id={id} type="button" variant="outline" aria-label={ariaLabel} className={cn("w-full justify-start px-3 text-left font-normal", !value && "text-muted-foreground", className)}>
        <CalendarDays className="h-4 w-4" />
        {selected ? format(selected, "MMMM yyyy") : placeholder}
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-72 p-3" align="start">
      <div className="mb-3 flex items-center justify-between">
        <Button type="button" variant="ghost" size="icon" className="h-9 min-h-9 w-9" onClick={() => setVisibleYear((year) => year - 1)} aria-label="Previous year"><ChevronLeft className="h-4 w-4" /></Button>
        <p className="text-sm font-semibold">{visibleYear}</p>
        <Button type="button" variant="ghost" size="icon" className="h-9 min-h-9 w-9" onClick={() => setVisibleYear((year) => year + 1)} aria-label="Next year"><ChevronRight className="h-4 w-4" /></Button>
      </div>
      <div className="grid grid-cols-3 gap-2">{Array.from({ length: 12 }, (_, index) => {
        const month = new Date(visibleYear, index, 1);
        const disabled = minimum ? month < minimum : false;
        const active = selected ? selected.getFullYear() === visibleYear && selected.getMonth() === index : false;
        return <Button type="button" key={index} variant={active ? "default" : "ghost"} size="sm" disabled={disabled} onClick={() => { onChange(monthValue(month)); setOpen(false); }}>{format(month, "MMM")}</Button>;
      })}</div>
      {!required && value && <div className="mt-3 border-t pt-2"><Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => { onChange(""); setOpen(false); }}>Clear month</Button></div>}
    </PopoverContent>
  </Popover>;
}
