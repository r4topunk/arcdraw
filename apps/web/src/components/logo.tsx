export function LogoMark({ className = "size-6" }: { className?: string }) {
  // An arc over a pinned point: the future round the request commits to.
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden fill="none">
      <rect width="32" height="32" rx="7" className="fill-primary" />
      <path d="M7 22a9 9 0 0 1 18 0" className="stroke-primary-foreground" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="22.4" cy="15.6" r="3.2" className="fill-signal" />
    </svg>
  );
}
