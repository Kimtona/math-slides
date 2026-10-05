/**
 * Academic Block types and their semantic color families — the single source for type → family.
 * Related statements share one family (Theorem / Lemma / Proposition are all blue); the label, not
 * the color, tells them apart. The family's actual colors live in src/styles.css (`.ablock[data-family]`),
 * which both the DOM and the PPTX export read.
 */
export type BlockFamily = 'gray' | 'blue' | 'teal' | 'green' | 'amber';

export const ACADEMIC_BLOCK_TYPES: { id: string; label: string; family: BlockFamily }[] = [
  { id: 'block', label: 'Block', family: 'gray' },
  { id: 'theorem', label: 'Theorem', family: 'blue' },
  { id: 'definition', label: 'Definition', family: 'teal' },
  { id: 'lemma', label: 'Lemma', family: 'blue' },
  { id: 'proposition', label: 'Proposition', family: 'blue' },
  { id: 'example', label: 'Example', family: 'green' },
  { id: 'remark', label: 'Remark', family: 'amber' },
];

export const DEFAULT_BLOCK_TYPE = 'block';

/** Unknown / missing types (e.g. from a hand-edited file) fall back to the plain Block. */
export const blockTypeInfo = (id: unknown) =>
  ACADEMIC_BLOCK_TYPES.find((t) => t.id === id) ?? ACADEMIC_BLOCK_TYPES[0];
