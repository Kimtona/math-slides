import type { PMNode } from '../model/types';

const isMath = (n: PMNode) => n.type === 'mathInline' || n.type === 'mathBlock';

export function isDocEmpty(doc: PMNode): boolean {
  const walk = (n: PMNode): boolean => {
    if (isMath(n)) return false;
    if (n.type === 'text') return !n.text?.trim();
    return (n.content ?? []).every(walk);
  };
  return walk(doc);
}

export function plainText(doc: PMNode): string {
  const blocks: string[] = [];
  const inline = (n: PMNode): string =>
    n.type === 'text' ? n.text ?? ''
      : n.type === 'hardBreak' ? '\n'
      : n.type === 'mathInline' ? `$${n.attrs?.latex ?? ''}$`
      : (n.content ?? []).map(inline).join('');
  const block = (n: PMNode) => {
    if (n.type === 'paragraph') blocks.push(inline(n));
    else if (n.type === 'mathBlock') blocks.push(`$$${n.attrs?.latex ?? ''}$$`);
    else (n.content ?? []).forEach(block);
  };
  block(doc);
  return blocks.join('\n');
}

export function textToDoc(text: string): PMNode {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return {
    type: 'doc',
    content: lines.map((l) => (l ? { type: 'paragraph', content: [{ type: 'text', text: l }] } : { type: 'paragraph' })),
  };
}

/** Drop trailing empty paragraphs (left behind e.g. after a block equation). */
export function trimTrailingEmpty(doc: PMNode): PMNode {
  const c = [...(doc.content ?? [])];
  while (c.length > 1 && c[c.length - 1].type === 'paragraph' && !c[c.length - 1].content?.length) c.pop();
  return c.length === doc.content?.length ? doc : { ...doc, content: c };
}
