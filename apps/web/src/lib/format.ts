import { formatUnits, parseUnits } from "viem";

export const USDC_DECIMALS = 6;

/** Format a 6-decimal USDC amount (ERC-20 units), trimming trailing zeros but keeping 2 decimals. */
export function formatUsdc(value: bigint, opts: { symbol?: boolean } = {}) {
  const s = formatUnits(value, USDC_DECIMALS);
  const [int, frac = ""] = s.split(".");
  const f = frac.replace(/0+$/, "").padEnd(2, "0");
  const intFmt = BigInt(int).toLocaleString("en-US");
  return `${intFmt}.${f}${opts.symbol === false ? "" : " USDC"}`;
}

/** Parse user input into 6-decimal USDC units. Returns null on invalid input. */
export function parseUsdc(input: string): bigint | null {
  const t = input.trim();
  if (t === "") return 0n;
  if (!/^\d+(\.\d{0,6})?$/.test(t)) return null;
  try {
    return parseUnits(t, USDC_DECIMALS);
  } catch {
    return null;
  }
}

export const shortHex = (h: string, head = 6, tail = 4) =>
  h.length <= head + tail + 2 ? h : `${h.slice(0, head + 2)}…${h.slice(-tail)}`;

export function formatTime(unixSeconds: bigint | number) {
  const d = new Date(Number(unixSeconds) * 1000);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export const formatInt = (v: bigint | number) => BigInt(v).toLocaleString("en-US");
