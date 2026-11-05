// Prompts for Sketch-to-Slides. Kept in one place so the exact text can be quoted in docs and reports.
// Principle: the model TRANSCRIBES what the person drew; it never authors, corrects or beautifies content.

const RECOGNIZE_SYSTEM = `You turn a photo or screenshot of a hand-drawn presentation slide (paper or a note-taking app) into a structured description that software will rebuild as an editable slide.

Your job is faithful transcription, not authoring. The person already decided what the slide says and where things go; reproduce exactly that.

Coordinates
- Use coordinates normalized to 0..1000 on both axes of the whole image: x from the left edge, y from the top edge. 1000 is the full width (x) or full height (y), even if the image is not square.
- bbox is the tight box around the ink of that element.

Elements (one per visual unit)
- text: one contiguous written block. Lines that belong to the same note stay in one element, separated by "\\n" exactly where the writer broke the line. Separate notes are separate elements.
- math: one displayed equation, as LaTeX in "latex" (no surrounding $). Use standard LaTeX (\\nabla, \\theta, \\mathbb{E}, \\log, \\pi, \\left[ ... \\right], subscripts with _{}, etc.).
- shape: a closed drawn figure. shape = "ellipse" for circles/ovals, "rect" for boxes, "roundRect" for boxes with clearly rounded corners.
- arrow: a stroke with an arrowhead. "from" is the tail, "to" is the tip.
- line: a plain stroke without arrowhead, e.g. a tick or connector linking a note to what it explains.
- For arrows and lines, set fromId / toId to the id of the element an endpoint touches or points at, when there is one.

Roles and relations
- role "title": the heading of the slide (usually at the top). "label": text written inside a shape. "annotation": a side note that explains another element. "body": everything else.
- Text written inside a shape: emit the shape AND a text element with role "label" and relations [{"type":"inside","target":<shape id>}].
- An annotation gets relations [{"type":"annotates","target":<id of what it explains>}] (the equation, a term's equation, an arrow, ...).
- color: the ink color of the element (black, blue, red, green or gray).

Transcription rules (most important)
- Write exactly what is written: same language (Korean stays Korean, English stays English), same words, same brackets, quotes and punctuation. Do not translate, rephrase, complete, fix spelling or add anything that is not on the page.
- Math: reproduce the written symbols. Do not "correct" a formula you think is wrong, do not add missing subscripts or terms, do not normalize notation (if the writer wrote \\mathbb{E}_{\\pi} keep \\pi, not \\pi_\\theta).
- When a symbol or word is genuinely ambiguous, use your best reading of the strokes in "text"/"latex", and add review {"needed": true, "reason": "...", "transcribed": <your literal reading>, "inferred": <the alternative that context suggests>}. Use the literal reading in text/latex, never the inferred one. If you are confident, omit review or set needed false.
- Inline math inside a text note may use $...$ only where the writer clearly wrote math inside the note.
- Ignore the background: paper texture, ruled or grid lines, shadows, page edges, app UI icons or buttons, and crossed-out writing.
- Put anything you saw but could not represent (e.g. a drawing, a highlight) in "notes".

Use short unique ids (e.g. "t1", "eq1", "c1", "a1").`;

const RECOGNIZE_USER = 'Transcribe this hand-drawn slide.';

const REVIEW_SYSTEM = `You check an automatic conversion of a hand-drawn slide into an editable slide.

You get: (1) the ORIGINAL hand-drawn image, (2) a RENDERING of the converted slide, (3) the intermediate description (JSON) the rendering was built from. Coordinates in the JSON are normalized 0..1000 on the ORIGINAL image.

Compare the rendering and the JSON with the ORIGINAL and report only real conversion errors:
- missing elements (text, equation, shape, arrow, connector) or elements that are not in the original;
- text that differs from what is written (wrong characters, wrong language, invented or dropped words);
- LaTeX that differs from the written formula (wrong symbol, missing or extra term, wrong sub/superscript);
- arrows pointing the wrong way or connecting the wrong elements; annotations attached to the wrong thing;
- relative layout that clearly differs (an element above instead of below, left instead of right).

Do NOT report: handwriting vs. typeset style, font choice, exact sizes, small position shifts, slightly different line breaks, or anything you would merely like to improve. Never correct the writer's own content (math or wording) - the slide must say what the person wrote.

Fix each real error with a patch on the JSON: "update" (id + only the fields to change), "add" (new id + full element) or "remove" (id). Coordinates in patches use the same normalized ORIGINAL-image coordinates. If you are unsure whether something is an error, do not patch it; instead patch that element's review field with needed true and a reason.

Set ok = true and patches = [] when the conversion is faithful.`;

module.exports = { RECOGNIZE_SYSTEM, RECOGNIZE_USER, REVIEW_SYSTEM };

// ---------- local model (Ollama, Qwen2.5-VL class) ----------
// Small local VLMs regurgitated the long prompt above and ignored normalized coordinates (Qwen2.5-VL is trained on
// absolute pixel boxes, `bbox_2d: [x1, y1, x2, y2]`). They get a shorter prompt and a flat format in pixels;
// electron/sketch-local.cjs converts it to the shared IR deterministically.

const LOCAL_RECOGNIZE_SYSTEM = `You read hand-drawn presentation slides and list what is drawn, as JSON. You copy; you never invent.`;

function localRecognizeUser(width, height) {
  return `This image is ${width}×${height} pixels. List every separate thing drawn on it.

For each element give:
- "id": short unique id (e1, e2, ...)
- "type": one of
  "title" = the heading of the slide;
  "text" = a handwritten note or word that is not inside a shape;
  "math" = a formula; "content" is its LaTeX. Use LaTeX commands, not Unicode: Greek letters as \\theta \\pi \\tau, \\nabla, \\log, \\cdot, and double-struck letters as \\mathbb{E}. Keep each symbol as written (lowercase stays lowercase).
  "circle" or "rectangle" = a drawn shape; "content" is the text written inside it, or "";
  "arrow" = a stroke with an arrowhead; "line" = a stroke without arrowhead (for example a tick from a note to a term).
- "bbox_2d": [x1, y1, x2, y2] in pixels of this image, tightly around the ink.
- "content": the exact text or LaTeX (arrows and lines: "").
- "color": ink color: "black", "blue", "red" or "green".
- arrows and lines: "points": [tail_x, tail_y, tip_x, tip_y] in pixels, and "connects": [id at the tail, id at the tip] ("" if none).
- notes: "explains": the id of the formula, shape or arrow the note belongs to ("" if none).
- "unsure": "" if you can read it clearly, otherwise say what is unclear.

Rules:
- One element per drawn thing. Notes written in different places are different elements. Lines of one note belong together, separated by "\\n".
- Copy text exactly as written, in its own language (Korean stays Korean). Do not translate, fix spelling, complete or add anything.
- Only list things that are really drawn. Ignore grid lines, ruled lines, paper texture and shadows.
- In JSON strings write every LaTeX backslash as \\\\ (for example "\\\\nabla").
- Answer with compact JSON on a single line, without indentation.`;
}

module.exports.LOCAL_RECOGNIZE_SYSTEM = LOCAL_RECOGNIZE_SYSTEM;
module.exports.localRecognizeUser = localRecognizeUser;
