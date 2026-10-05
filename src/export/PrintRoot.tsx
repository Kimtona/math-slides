import { useStore } from '../store/store';
import { SlideView } from '../render/ElementView';

/**
 * All slides at 1:1 (1280×720 px = 13.333×7.5 in). Mounted only while exporting:
 * - PDF: this is what gets printed (@media print hides the editor UI).
 * - PPTX: positions of text lines / equations are measured from this DOM.
 */
export function PrintRoot() {
  const mode = useStore((s) => s.exportMode);
  const deck = useStore((s) => s.deck);
  const assets = useStore((s) => s.assets);
  if (!mode) return null;
  return (
    <div className="print-root" id="print-root">
      {deck.slides.map((s, i) => (
        <div className="print-page" key={s.id}>
          <SlideView slide={s} assets={assets} index={i} total={deck.slides.length} />
        </div>
      ))}
    </div>
  );
}
