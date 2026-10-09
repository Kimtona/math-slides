/**
 * Global typography — the single source of truth for font sizes (px on the 1280×720 slide).
 * These are the BUILT-IN defaults. The Markdown shortcuts (#, ##, ###, ####) and the slide templates read the
 * effective size through `headingSize()` (model/defaults.ts), which applies the user's config.txt on top.
 */
export const TYPOGRAPHY = {
  h1: 80,
  h2: 50,
  h3: 30,
  body: 25,
  /** Default size of a new Code Block (`/code`), independent of the text box size. */
  code: 16,
  /** Image caption (px on the 1280×720 slide = pt in the 13.333in deck). */
  caption: 14,
} as const;

/** Instance border (text boxes, images): one thin solid line, centered on the element bounds (px on the 1280×720 slide = 1.5pt). */
export const INSTANCE_BORDER_WIDTH = 2;

export const CAPTION_COLOR = '#6B7280';
/** Gap between an image's bottom edge and its caption. */
export const CAPTION_GAP = 6;

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
