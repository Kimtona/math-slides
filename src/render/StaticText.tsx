import { memo, useMemo, type CSSProperties, type ReactNode } from 'react';
import { useStore } from '../store/store';
import type { PMNode } from '../model/types';
import { renderTex } from '../math/mathjax';
import { inlineCodeStyle } from '../editor/formattingMarks';

/** Renders math exactly like the editor node views do (same classes & markup). */
export const MathView = memo(function MathView({ latex, display }: { latex: string; display: boolean }) {
  const Tag = display ? 'div' : 'span';
  const cls = display ? 'math-block' : 'math-inline';
  if (!latex.trim()) return <Tag className={`${cls} math-empty`} data-latex="">{display ? '새 수식 (New equation)' : '수식'}</Tag>;
  const r = renderTex(latex, display);
  if (r.error !== undefined) return <Tag className={`${cls} math-error`} title={r.error} data-latex={latex}>{latex}</Tag>;
  return <Tag className={cls} data-latex={latex} dangerouslySetInnerHTML={{ __html: r.svg }} />;
});

const codeStyle = Object.fromEntries(inlineCodeStyle.split(';').map((d) => d.split(':').map((x) => x.trim()))
  .map(([k, v]) => [k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v])) as CSSProperties;

function renderMarks(text: string, marks: PMNode['marks'], key: number): ReactNode {
  let node: ReactNode = text;
  // Wrap innermost-first so the first mark ends up outermost, exactly like ProseMirror's DOM.
  for (const m of [...(marks ?? [])].reverse()) {
    switch (m.type) {
      case 'bold': node = <strong>{node}</strong>; break;
      case 'italic': node = <em>{node}</em>; break;
      case 'underline': node = <u>{node}</u>; break;
      case 'strike': node = <s>{node}</s>; break;
      case 'highlight': node = <mark style={{ backgroundColor: m.attrs?.color, color: 'inherit' }}>{node}</mark>; break;
      case 'code': node = <code style={codeStyle}>{node}</code>; break;
      case 'textStyle':
        if (m.attrs?.color) node = <span style={{ color: m.attrs.color }}>{node}</span>;
        break;
      case 'link':
        if (m.attrs?.href) node = <a className="doc-link" href={m.attrs.href} target="_blank" rel="noopener noreferrer">{node}</a>;
        break;
    }
  }
  return <span key={key}>{node}</span>;
}

/** sectionId → Sub-title slide id, for Table of Contents links. */
type Ctx = Record<string, string>;

function renderParagraph(n: PMNode, key: number, ctx: Ctx, linkHref?: string): ReactNode {
  const c = n.content ?? [];
  // ProseMirror adds a trailing <br> to empty paragraphs and after a final hard break.
  const trailing = !c.length || c[c.length - 1].type === 'hardBreak' ? <br className="ProseMirror-trailingBreak" /> : null;
  const fs = n.attrs?.fontSize;
  const inline = c.map((x, i) => renderNode(x, i, ctx));
  return (
    <p key={key} style={fs ? { fontSize: fs } : undefined}>
      {linkHref ? <a className="toc-link" href={linkHref}>{inline}</a> : inline}{trailing}
    </p>
  );
}

function renderNode(n: PMNode, key: number, ctx: Ctx): ReactNode {
  const kids = () => (n.content ?? []).map((c, i) => renderNode(c, i, ctx));
  switch (n.type) {
    case 'doc': return <>{kids()}</>;
    case 'paragraph': return renderParagraph(n, key, ctx);
    case 'text': return renderMarks(n.text ?? '', n.marks, key);
    case 'hardBreak': return <br key={key} />;
    case 'bulletList': return <ul key={key}>{kids()}</ul>;
    case 'orderedList': return <ol key={key} start={n.attrs?.start ?? 1}>{kids()}</ol>;
    case 'listItem': {
      // TOC entry: its text is an internal link to the Sub-title slide (click to follow; internal link in PDF/PPTX).
      const target = n.attrs?.sectionId ? ctx[n.attrs.sectionId] : undefined;
      const [first, ...rest] = n.content ?? [];
      if (target && first?.type === 'paragraph') {
        return (
          <li key={key} data-section-id={n.attrs!.sectionId}>
            {renderParagraph(first, 0, ctx, `#slide-${target}`)}
            {rest.map((c, i) => renderNode(c, i + 1, ctx))}
          </li>
        );
      }
      return <li key={key}>{kids()}</li>;
    }
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
  const sections = useStore((s) => s.deck.sections);
  const ctx = useMemo(() => Object.fromEntries((sections ?? []).map((x) => [x.id, x.subtitleSlideId])), [sections]);
  return <div className="tb-content">{renderNode(doc, 0, ctx)}</div>;
});
