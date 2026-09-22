import { cn } from "@/lib/utils";

export function Badge({ className, tone = "neutral", ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "good" | "warn" | "bad" }) {
  return <span className={cn("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium", tone === "good" && "bg-emerald-100 text-emerald-800", tone === "warn" && "bg-amber-100 text-amber-800", tone === "bad" && "bg-red-100 text-red-800", tone === "neutral" && "bg-muted text-muted-foreground", className)} {...props} />;
}
