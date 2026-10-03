import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';
import { DocsHeading } from './docs-heading';
import { DocsPre } from './docs-pre';
import { Mermaid } from './mermaid';

const heading = (as: ComponentProps<typeof DocsHeading>['as']) =>
  function Heading(props: ComponentProps<'h1'>) {
    return <DocsHeading as={as} {...props} />;
  };

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    h1: heading('h1'),
    h2: heading('h2'),
    h3: heading('h3'),
    h4: heading('h4'),
    h5: heading('h5'),
    h6: heading('h6'),
    pre: DocsPre,
    Mermaid,
    ...components,
  };
}
