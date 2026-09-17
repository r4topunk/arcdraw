import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva("rounded-md border px-4 py-3 text-sm [&_a]:underline", {
  variants: {
    variant: {
      default: "bg-muted border-border",
      danger: "bg-danger-soft border-danger/30 text-danger",
      ok: "bg-ok-soft border-ok/30 text-ok",
      warn: "bg-warn-soft border-warn/30 text-warn",
    },
  },
  defaultVariants: { variant: "default" },
});

export function Alert({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return (
    <div
      role={variant === "danger" ? "alert" : "status"}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}
