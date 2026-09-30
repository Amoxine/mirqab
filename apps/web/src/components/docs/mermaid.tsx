'use client';

import { useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';

// mermaid is imported dynamically so its ~MB of code is a separate chunk, fetched only on pages
// that actually contain a diagram.
export function Mermaid({ chart }: { chart: string }) {
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
      } catch {
        if (!state.cancelled) setFailed(true);
      }
    })();
    return () => {
      state.cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  if (failed) return <pre dir="ltr">{chart}</pre>;
  // Diagram text (node ids, arrows) is LTR by nature; keep it isolated inside an RTL page.
  return <div dir="ltr" className="my-4 flex justify-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
}
