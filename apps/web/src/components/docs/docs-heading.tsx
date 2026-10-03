import type { ComponentProps } from 'react';
import { Link } from 'lucide-react';
import { cn } from 'fumadocs-ui/utils/cn';

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/**
 * Fumadocs' heading (its text is the anchor link) without the `aria-label="Link to section"` it puts, in
 * English in every language, on the decorative icon beside it: the icon is hidden from assistive technology
 * because the heading's own link already says where it goes.
 */
export function DocsHeading({ as: Tag, className, children, ...props }: ComponentProps<'h1'> & { as: HeadingTag }) {
  if (!props.id) {
    return (
      <Tag className={className} {...props}>
        {children}
      </Tag>
    );
  }
  return (
    <Tag className={cn('flex scroll-m-28 flex-row items-center gap-2', className)} {...props}>
      <a data-card="" href={`#${props.id}`} className="peer">
        {children}
      </a>
      <Link
        aria-hidden="true"
        className="text-fd-muted-foreground size-3.5 shrink-0 opacity-0 transition-opacity peer-hover:opacity-100"
      />
    </Tag>
  );
}
