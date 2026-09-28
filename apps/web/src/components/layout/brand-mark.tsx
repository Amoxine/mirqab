/** The MIRQAB hexagon: the control plane at the centre, spokes out to the gateway nodes. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <path
        d="M16 4 27 10v12L16 28 5 22V10L16 4Z"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="4" stroke="currentColor" strokeWidth="2.1" />
      <path
        d="M16 7v5M9 22l4.2-3.4M23 22l-4.2-3.4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
