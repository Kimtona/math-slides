import { Mark } from '@tiptap/core';
import { HIGHLIGHT_COLORS } from '../model/colors';
import { INLINE_CODE_BACKGROUND, INLINE_CODE_COLOR, INLINE_CODE_FONT } from '../model/textFormatting';

/** Independent marks: applying one never excludes color, emphasis, links, or the other mark. */
// priority > TextStyle's 101: highlight/code wrap the color span, so an explicit text color on code wins.
export const Highlight = Mark.create({
  name: 'highlight',
  priority: 102,
  excludes: 'highlight',
  addAttributes() {
    return { color: {
      default: HIGHLIGHT_COLORS[0].hex,
      parseHTML: (el) => el.style.backgroundColor || HIGHLIGHT_COLORS[0].hex,
      renderHTML: ({ color }) => ({ style: `background-color: ${color}; color: inherit` }),
    } };
  },
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: ({ HTMLAttributes }) => ['mark', HTMLAttributes, 0],
});

/** Shared by the editor and the static (thumbnail/presenter/PDF) renderer. Colors are CSS variables so a
 *  highlight on the same text can make the code background transparent (see styles.css). */
export const inlineCodeStyle = `font-family: ${INLINE_CODE_FONT}, monospace; --code-color: ${INLINE_CODE_COLOR}; --code-background: ${INLINE_CODE_BACKGROUND}`;

export const InlineCode = Mark.create({
  name: 'code',
  priority: 102,
  code: true,
  excludes: '',
  exitable: true,
  parseHTML: () => [{ tag: 'code' }],
  renderHTML: () => ['code', { style: inlineCodeStyle }, 0],
  // No Mod-E binding: the app already uses it to export PPTX. No code blocks/input rules.
});
