import { memo, type ReactNode } from 'react';
import type { PMNode } from '../model/types';
import { renderTex } from '../math/mathjax';

/** Renders math exactly like the editor node views do (same classes & markup). */
export const MathView = memo(function MathView({ latex, display }: { latex: string; display: boolean }) {
  const Tag = display ? 'div' : 'span';
  const cls = display ? 'math-block' : 'math-inline';
  if (!latex.trim()) return <Tag className={`${cls} math-empty`} data-latex="">{display ? '새 수식 (New equation)' : '수식'}</Tag>;
  const r = renderTex(latex, display);
  if (r.error !== undefined) return <Tag className={`${cls} math-error`} title={r.error} data-latex={latex}>{latex}</Tag>;
  return <Tag className={cls} data-latex={latex} dangerouslySetInnerHTML={{ __html: r.svg }} />;
});

function renderMarks(text: string, marks: PMNode['marks'], key: number): ReactNode {
  let node: ReactNode = text;
  for (const m of marks ?? []) {
    switch (m.type) {
      case 'bold': node = <strong>{node}</strong>; break;
      case 'italic': node = <em>{node}</em>; break;
      case 'underline': node = <u>{node}</u>; break;
      case 'strike': node = <s>{node}</s>; break;
      case 'textStyle':
        if (m.attrs?.color) node = <span style={{ color: m.attrs.color }}>{node}</span>;
        break;
    }
  }
  return <span key={key}>{node}</span>;
}

function renderNode(n: PMNode, key: number): ReactNode {
  const kids = () => (n.content ?? []).map(renderNode);
  switch (n.type) {
    case 'doc': return <>{kids()}</>;
    case 'paragraph': {
      const c = n.content ?? [];
      // ProseMirror adds a trailing <br> to empty paragraphs and after a final hard break.
      const trailing = !c.length || c[c.length - 1].type === 'hardBreak' ? <br className="ProseMirror-trailingBreak" /> : null;
      const fs = n.attrs?.fontSize;
      return <p key={key} style={fs ? { fontSize: fs } : undefined}>{kids()}{trailing}</p>;
    }
    case 'text': return renderMarks(n.text ?? '', n.marks, key);
    case 'hardBreak': return <br key={key} />;
    case 'bulletList': return <ul key={key}>{kids()}</ul>;
    case 'orderedList': return <ol key={key} start={n.attrs?.start ?? 1}>{kids()}</ol>;
    case 'listItem': return <li key={key}>{kids()}</li>;
    case 'mathInline': {
      // Inline equations can carry marks (e.g. a color applied to a selection that contains them).
      const color = n.marks?.find((m) => m.type === 'textStyle')?.attrs?.color;
      const math = <MathView latex={n.attrs?.latex ?? ''} display={false} />;
      return color ? <span key={key} style={{ color }}>{math}</span> : <span key={key}>{math}</span>;
    }
    case 'mathBlock': return <MathView key={key} latex={n.attrs?.latex ?? ''} display />;
    default: return <>{kids()}</>;
  }
}

export const StaticText = memo(function StaticText({ doc }: { doc: PMNode }) {
  return <div className="tb-content">{renderNode(doc, 0)}</div>;
});
