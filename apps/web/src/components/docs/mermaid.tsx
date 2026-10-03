'use client';

import { useEffect, useId, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { cn } from 'fumadocs-ui/utils/cn';

/** The node texts of a flowchart in the order they are written: `A[text]` and `A["text"]`. */
function stepsOf(chart: string): string[] {
  const steps: string[] = [];
  for (const [, quoted, plain] of chart.matchAll(/\[(?:"([^"]*)"|([^\]"]*))\]/g)) {
    const step = (quoted ?? plain ?? '').trim();
    if (step && !steps.includes(step)) steps.push(step);
  }
  return steps;
}

// mermaid is imported dynamically so its ~MB of code is a separate chunk, fetched only on pages
// that actually contain a diagram.
export function Mermaid({ chart }: { chart: string }) {
  const t = useTranslations('docs.shell');
  const format = useFormatter();
  const id = useId().replace(/:/g, '');
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const state = { cancelled: false };
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          fontFamily: 'inherit',
          theme: resolvedTheme === 'dark' ? 'dark' : 'default',
        });
        const { svg: out } = await mermaid.render(`m${id}`, chart.replaceAll('\\n', '\n'));
        if (!state.cancelled) setSvg(out);
      } catch (error) {
        // The page still shows the diagram's text; the console says why it is not drawn.
        console.error('Rendering a documentation diagram failed', error);
        if (!state.cancelled) setFailed(true);
      }
    })();
    return () => {
      state.cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  if (failed) return <pre dir="ltr">{chart}</pre>;
  // Diagram text (node ids, arrows) is LTR by nature; keep it isolated inside an RTL page. A screen reader
  // gets the steps in order, since the drawing itself is not readable; the min-height keeps the page from
  // jumping when the drawing arrives.
  return (
    <div
      dir="ltr"
      role="img"
      aria-label={t('diagram', { steps: format.list(stepsOf(chart), { type: 'unit' }) })}
      className={cn('my-4 flex justify-center overflow-x-auto', !svg && 'min-h-24')}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
