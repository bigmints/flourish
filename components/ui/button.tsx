import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva("inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50", {
  variants: {
    variant: {
      default: "bg-primary px-4 text-primary-foreground shadow-sm hover:bg-primary/90",
      secondary: "bg-secondary px-4 text-secondary-foreground hover:bg-secondary/80",
      outline: "border border-border bg-background px-4 hover:bg-accent",
      ghost: "px-3 hover:bg-accent",
      destructive: "bg-destructive px-4 text-destructive-foreground hover:bg-destructive/90"
    },
    size: { default: "h-11", sm: "h-9 min-h-9 rounded-lg px-3", icon: "h-11 w-11 p-0" }
  },
  defaultVariants: { variant: "default", size: "default" }
});

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean }

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, ...props }, ref) => {
  const Component = asChild ? Slot : "button";
  return <Component className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
});
Button.displayName = "Button";
