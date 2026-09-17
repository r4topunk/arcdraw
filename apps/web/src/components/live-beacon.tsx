"use client";

import { ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchBeacon, QUICKNET, roundAt, roundTime, verifyBeacon, type Beacon } from "@/lib/drand";
import { cn } from "@/lib/utils";

type Shown = { beacon: Beacon; verified: boolean; ms: number };

export function LiveBeacon() {
  const [now, setNow] = useState<number | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState(false);
  const lastRound = useRef<bigint>(0n);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    setNow(Date.now());
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let stop = false;
    const ctrl = new AbortController();
    async function tick() {
      const target = roundAt(BigInt(Math.floor(Date.now() / 1000)));
      if (target <= lastRound.current) return;
      try {
        const b = await fetchBeacon(target, ctrl.signal);
        const t0 = performance.now();
        const ok = verifyBeacon(b);
        const ms = performance.now() - t0;
        if (stop) return;
        lastRound.current = b.round;
        setShown({ beacon: b, verified: ok, ms });
        setError(false);
      } catch {
        if (!stop) setError(true);
      }
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      stop = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, []);

  const nowS = now === null ? null : now / 1000;
  const current = nowS === null ? null : roundAt(BigInt(Math.floor(nowS)));
  const progress =
    nowS === null || current === null
      ? 0
      : Math.min(1, (nowS - Number(roundTime(current))) / Number(QUICKNET.period));
  const bytes = shown ? shown.beacon.randomness.slice(2).match(/../g) ?? [] : Array.from({ length: 32 }, () => "··");

  return (
    <section
      aria-label="Live drand quicknet beacon"
      className="relative overflow-hidden rounded-xl border bg-card shadow-[0_1px_0_var(--border),0_24px_48px_-28px_oklch(0.2_0.02_262/0.35)]"
    >
      <div className="flex items-center justify-between border-b px-4 py-2.5 font-mono text-[0.7rem] uppercase tracking-widest text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="relative flex size-2" aria-hidden>
            <span className="animate-pulse-ring absolute inline-flex size-full rounded-full bg-signal" />
            <span className="relative inline-flex size-2 rounded-full bg-signal" />
          </span>
          drand quicknet · live
        </span>
        <span>every 3s</span>
      </div>

      <div className="grid gap-5 p-4 sm:p-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Latest round</p>
            <p className="text-display tabular text-3xl font-semibold sm:text-4xl" aria-live="off">
              {shown ? `#${shown.beacon.round.toLocaleString("en-US")}` : current ? `#${current.toLocaleString("en-US")}` : "#…"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">A request now pins</p>
            <p className="tabular font-mono text-lg text-signal-ink">
              {current ? `#${(current + 2n).toLocaleString("en-US")}` : "…"}
            </p>
          </div>
        </div>

        <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full origin-left rounded-full bg-signal transition-transform duration-100 ease-linear" style={{ transform: `scaleX(${progress})` }} />
        </div>

        <div>
          <p className="mb-2 text-xs text-muted-foreground">Randomness = sha256(BLS signature)</p>
          <div className="grid grid-cols-8 gap-1 font-mono text-[0.72rem] sm:text-xs" aria-label={shown ? `Randomness ${shown.beacon.randomness}` : "Waiting for beacon"}>
            {bytes.map((b, i) => (
              <span
                key={`${shown?.beacon.round ?? "x"}-${i}`}
                className={cn(
                  "rounded-sm py-1 text-center tabular transition-colors",
                  shown ? "bg-muted text-foreground" : "bg-muted/60 text-muted-foreground",
                  i % 9 === 0 && shown && "bg-signal-soft text-signal-ink",
                )}
              >
                {b}
              </span>
            ))}
          </div>
        </div>

        <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {shown ? (
            shown.verified ? (
              <span className="inline-flex items-center gap-1.5 text-ok">
                <ShieldCheck className="size-4" aria-hidden />
                BLS12-381 signature verified in your browser ({shown.ms.toFixed(0)} ms)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-danger">
                <ShieldAlert className="size-4" aria-hidden /> Signature did not verify
              </span>
            )
          ) : error ? (
            <span className="text-muted-foreground">drand API unreachable from this browser. Round math still runs locally.</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Fetching beacon…
            </span>
          )}
        </div>
        <p className="border-t pt-3 text-xs text-muted-foreground">
          The ArcDraw coordinator runs the same pairing check onchain through Arc&apos;s EIP-2537 precompiles.
        </p>
      </div>
    </section>
  );
}
