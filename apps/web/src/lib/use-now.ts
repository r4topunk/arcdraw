"use client";

import { useEffect, useState } from "react";

/** Current unix time in seconds, updated every `ms`. Null until mounted (avoids hydration mismatch). */
export function useNow(ms = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now() / 1000);
    const id = setInterval(() => setNow(Date.now() / 1000), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
