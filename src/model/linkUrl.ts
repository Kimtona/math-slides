/** Pure URL helpers for user-created hyperlinks (typing/paste detection and the Cmd+K field). No DOM, no editor. */

/** Characters allowed in an auto-detected URL. ASCII only, so Korean text glued to a URL never becomes part of it. */
const URL_RE = /(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;
const TRAILING = /[.,;:!?'"*]$/;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** Drops trailing sentence punctuation, and closing brackets that have no opener inside the URL. */
export function trimUrl(url: string): string {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if (TRAILING.test(u)) u = u.slice(0, -1);
    else if (last && CLOSERS[last] && count(u, last) > count(u, CLOSERS[last])) u = u.slice(0, -1);
    else return u;
  }
}
const count = (s: string, c: string) => s.split(c).length - 1;

/** href for a URL as typed: `www.` gets https://; only http(s) with a host is accepted. */
export function toHref(url: string): string | null {
  const u = url.trim();
  if (!u || /\s/.test(u)) return null;
  const full = /^www\./i.test(u) ? 'https://' + u : /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : 'https://' + u;
  try {
    const p = new URL(full);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
    if (!p.hostname || !/^[^\s]+$/.test(full)) return null;
    // "https://x" is fine; a bare word without a dot and without a scheme typed by the user ("hello") is not a link.
    if (!/^https?:\/\//i.test(u) && !p.hostname.includes('.')) return null;
    return full;
  } catch {
    return null;
  }
}

/**
 * The URL that ends exactly at the end of `before` (the text before the caret), if the last whitespace-delimited word is one.
 * Returns the match offsets inside `before`. Leading brackets/quotes around the URL are not part of it.
 */
export function urlEndingAt(before: string): { start: number; end: number; href: string } | null {
  const wordStart = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n'), before.lastIndexOf('\t'), before.lastIndexOf(' ')) + 1;
  const word = before.slice(wordStart);
  URL_RE.lastIndex = 0;
  const m = URL_RE.exec(word);
  if (!m) return null;
  const url = trimUrl(m[0]);
  const end = wordStart + m.index + url.length;
  // Anything but trailing punctuation after the URL (e.g. Korean text glued to it) means the caret is not at its end.
  if (!/^[.,;:!?'")\]}*]*$/.test(before.slice(end))) return null;
  const href = toHref(url);
  if (!href || url.replace(/^(https?:\/\/|www\.)/i, '').length < 1) return null;
  return { start: wordStart + m.index, end, href };
}

/** Pasted text that is exactly one URL (surrounding whitespace ignored). */
export function pastedUrl(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  const m = urlEndingAt(t);
  return m && m.start === 0 && m.end === t.length ? m.href : null;
}
