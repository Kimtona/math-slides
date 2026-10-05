import { createLowlight } from 'lowlight';
import python from 'highlight.js/lib/languages/python';
import c from 'highlight.js/lib/languages/c';
import bash from 'highlight.js/lib/languages/bash';

/**
 * Code Block languages and syntax highlighting — one tokenizer shared by the editor (decorations),
 * the static renderer (thumbnails / presenter / PDF) and therefore the PPTX export.
 * Highlighting is derived from (code text, language); nothing highlighted is ever stored.
 *
 * To add a language: import its highlight.js grammar, register it, and add it to CODE_LANGUAGES.
 */
export const CODE_LANGUAGES: { id: string | null; label: string }[] = [
  { id: null, label: 'Plain Text' },
  { id: 'python', label: 'Python' },
  { id: 'c', label: 'C' },
  { id: 'bash', label: 'Bash' },
];

const lowlight = createLowlight();
lowlight.register({ python, c, bash });

export const isSupportedLanguage = (lang: unknown): lang is string =>
  typeof lang === 'string' && CODE_LANGUAGES.some((l) => l.id === lang);

export interface CodeToken {
  text: string;
  /** highlight.js classes, e.g. ['hljs-keyword']; empty = plain text. */
  classes: string[];
}

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

/** Flat list of tokens covering the text exactly. Plain Text / unknown language → one plain token (no auto-detection). */
export function highlightCode(text: string, language: string | null | undefined): CodeToken[] {
  if (!text) return [];
  if (!isSupportedLanguage(language)) return [{ text, classes: [] }];
  const out: CodeToken[] = [];
  const walk = (node: HastNode, classes: string[]) => {
    if (node.type === 'text') { if (node.value) out.push({ text: node.value, classes }); return; }
    const own = node.properties?.className ?? [];
    node.children?.forEach((ch) => walk(ch, own.length ? [...classes, ...own] : classes));
  };
  walk(lowlight.highlight(language, text) as unknown as HastNode, []);
  return out;
}

/**
 * Token colors (muted GitHub-light-like). Single source for the PPTX export; src/styles.css mirrors
 * them for the DOM. Order = priority (first match wins), so a more specific class must come first.
 */
export const CODE_TOKEN_COLORS: [cls: string, color: string][] = [
  ['hljs-comment', '#6A737D'], ['hljs-quote', '#6A737D'],
  ['hljs-keyword', '#CF222E'], ['hljs-selector-tag', '#CF222E'],
  ['hljs-string', '#0A3069'], ['hljs-regexp', '#0A3069'],
  ['hljs-number', '#0550AE'], ['hljs-literal', '#0550AE'], ['hljs-symbol', '#0550AE'],
  ['class_', '#953800'], ['hljs-type', '#953800'],
  ['hljs-title', '#8250DF'], ['hljs-built_in', '#8250DF'], ['hljs-section', '#8250DF'],
  ['hljs-meta', '#116329'], ['hljs-variable', '#116329'], ['hljs-attr', '#116329'],
];

/** Color of a token, or null (inherit the element/default color). Innermost class wins, like CSS nesting. */
export function tokenColor(classes: string[]): string | null {
  for (let i = classes.length - 1; i >= 0; i--) {
    const hit = CODE_TOKEN_COLORS.find(([c]) => c === classes[i]);
    if (hit) return hit[1];
  }
  return null;
}
