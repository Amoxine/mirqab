import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { remarkMermaid } from './src/lib/docs/remark-mermaid';

export const docs = defineDocs({ dir: 'content/docs' });

// ```mermaid fences become <Mermaid chart="..."/> (client component, see components/docs/mermaid.tsx).
export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMermaid],
  },
});
