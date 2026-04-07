import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format a number as USD currency with proper locale formatting.
 * Handles Prisma Decimal types by converting to Number first.
 */
export function formatCurrency(
  value: number | string | { toString(): string } | null | undefined,
  opts?: { decimals?: number }
): string {
  const num = Number(value ?? 0);
  if (isNaN(num)) return "$0.00";
  const decimals = opts?.decimals ?? 2;
  return num.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
