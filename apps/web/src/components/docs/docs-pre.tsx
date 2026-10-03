'use client';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Check, Clipboard } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { cn } from 'fumadocs-ui/utils/cn';

/**
 * Fumadocs' code block with its copy button named in the reader's language (the original is labelled
 * "Copy Text" / "Copied Text" in English, which its i18n table cannot change). Same block, same copying,
 * except that a refused clipboard write is logged and not reported as "copied".
 */
export function DocsPre({ children, ...props }: ComponentProps<'pre'>) {
  const t = useTranslations('docs.shell');
  const figure = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const reset = useRef<number>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(reset.current);
    },
    [],
  );

  const onCopy = async () => {
    const pre = figure.current?.getElementsByTagName('pre').item(0);
    if (!pre) return;
    const clone = pre.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.nd-copy-ignore').forEach((node) => {
      node.replaceWith('\n');
    });
    try {
      await navigator.clipboard.writeText(clone.textContent);
    } catch (error) {
      console.error('Copying the code to the clipboard failed', error);
      return;
    }
    setCopied(true);
    window.clearTimeout(reset.current);
    reset.current = window.setTimeout(() => {
      setCopied(false);
    }, 1500);
  };

  return (
    <CodeBlock
      ref={figure}
      {...(props as ComponentProps<typeof CodeBlock>)}
      allowCopy={false}
      Actions={() => (
        <div className="text-fd-muted-foreground absolute top-2 right-2 z-2 rounded-lg backdrop-blur-lg">
          <button
            type="button"
            data-checked={copied || undefined}
            className={cn(
              buttonVariants({
                className: 'hover:text-fd-accent-foreground data-[checked]:text-fd-accent-foreground',
                size: 'icon-xs',
              }),
            )}
            aria-label={copied ? t('codeCopied') : t('copyCode')}
            onClick={() => void onCopy()}
          >
            {copied ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
          </button>
        </div>
      )}
    >
      <Pre>{children}</Pre>
    </CodeBlock>
  );
}
