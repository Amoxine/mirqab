import Image from 'next/image';

/** The MIRQAB watchtower logo, served from /public/logo.svg. Decorative: the brand name sits beside it. */
export function BrandMark({ className }: { className?: string }) {
  return <Image src="/logo.svg" alt="" width={160} height={160} unoptimized className={className} />;
}
