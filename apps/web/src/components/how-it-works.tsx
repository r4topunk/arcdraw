const steps = [
  {
    n: "01",
    t: "t",
    title: "Request pins a future round",
    body: "Your contract calls requestRandomness. The coordinator computes the drand round from block.timestamp and pins current + 4, which is published 9 to 12 seconds later. Nobody, including the requester, can know it yet.",
    code: "requestRandomness(gas, bounty)",
  },
  {
    n: "02",
    t: "t + 3–6s",
    title: "drand publishes the round",
    body: "The League of Entropy threshold network signs the round number with BLS12-381. The signature is public, unique and cannot be chosen by any single operator.",
    code: "sig = BLS.sign(sha256(round))",
  },
  {
    n: "03",
    t: "t + ~1 block",
    title: "Anyone fulfills and gets paid",
    body: "A relayer (or you) submits the 48-byte signature. Arc verifies the pairing onchain, derives keccak256(drand, chainId, coordinator, requestId), pays the USDC bounty and calls your contract back.",
    code: "fulfill(requestId, sig)",
  },
];

export function HowItWorks() {
  return (
    <ol className="relative grid gap-4 md:grid-cols-3 md:gap-0">
      {steps.map((s, i) => (
        <li key={s.n} className="relative flex flex-col md:pr-6">
          <div className="mb-4 flex items-center gap-3" aria-hidden>
            <span className="flex size-9 items-center justify-center rounded-full border-2 border-foreground bg-background font-mono text-xs font-semibold">
              {s.n}
            </span>
            {i < steps.length - 1 && (
              <span className="hidden h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--foreground)_0_6px,transparent_6px_12px)] md:block" />
            )}
          </div>
          <p className="font-mono text-xs uppercase tracking-widest text-signal-ink">{s.t}</p>
          <h3 className="text-display mt-1 text-xl font-semibold">{s.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
          <code className="mt-4 block w-fit max-w-full overflow-x-auto rounded border bg-card px-2.5 py-1.5 font-mono text-xs">{s.code}</code>
        </li>
      ))}
    </ol>
  );
}
