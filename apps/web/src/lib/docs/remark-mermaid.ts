// Minimal remark plugin: ```mermaid code fences -> <Mermaid chart="..." /> JSX element.
// (fumadocs-core 16 ships this as remarkMdxMermaid; the 15.x line we must use on Next 15 does not.)
interface MdNode {
  type: string;
  lang?: string | null;
  value?: string;
  name?: string;
  attributes?: unknown[];
  children?: MdNode[];
}

function walk(node: MdNode): void {
  if (!node.children) return;
  node.children = node.children.map((child) => {
    if (child.type === 'code' && child.lang === 'mermaid') {
      return {
        type: 'mdxJsxFlowElement',
        name: 'Mermaid',
        attributes: [{ type: 'mdxJsxAttribute', name: 'chart', value: child.value ?? '' }],
        children: [],
      };
    }
    walk(child);
    return child;
  });
}

export function remarkMermaid() {
  return (tree: MdNode) => {
    walk(tree);
  };
}
