import Image from 'next/image';

/**
 * The MIRQAB watchtower logo, served from /public/logo.svg. Decorative by default (the brand name sits
 * beside it); pass `alt` where the mark stands alone, and `priority` when it is above the fold.
 */
export function BrandMark({ className, alt = '', priority }: { className?: string; alt?: string; priority?: boolean }) {
  return <Image src="/logo.svg" alt={alt} width={160} height={160} unoptimized priority={priority} className={className} />;
}
