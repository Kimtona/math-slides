/**
 * Global typography — the single source of truth for font sizes (px on the 1280×720 slide).
 * Used by the Markdown shortcuts (#, ##, ###, ####) AND the slide templates;
 * change a value here and both follow.
 */
export const TYPOGRAPHY = {
  h1: 80,
  h2: 50,
  h3: 30,
  body: 25,
} as const;

/** Markdown prefix → font size: `# ` h1, `## ` h2, `### ` h3, `#### ` body. */
export const MARKDOWN_SIZES: Record<number, number> = {
  1: TYPOGRAPHY.h1,
  2: TYPOGRAPHY.h2,
  3: TYPOGRAPHY.h3,
  4: TYPOGRAPHY.body,
};

// ---------- slide footer (slide number bottom-left, reference bottom-right) ----------

/** Shared by the slide number and the reference field. */
export const FOOTER_FONT_SIZE = 16;
/** Distance from the slide's left/right edges. */
export const FOOTER_MARGIN_X = 32;
/** Distance from the slide's bottom edge (same for number and reference). */
export const FOOTER_MARGIN_Y = 18;
export const FOOTER_COLOR = '#808080';
/** Horizontal space kept free for the slide number so a long reference never overlaps it. */
export const FOOTER_NUMBER_RESERVE = 120;
