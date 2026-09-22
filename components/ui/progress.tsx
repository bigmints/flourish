import { cn } from "@/lib/utils";

export function Progress({ value, className }: { value: number; className?: string }) {
  return <div className={cn("h-2.5 overflow-hidden rounded-full bg-muted", className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.max(0, value))}><div className={cn("h-full rounded-full transition-all", value > 100 ? "bg-destructive" : value > 80 ? "bg-amber-500" : "bg-primary")} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}
