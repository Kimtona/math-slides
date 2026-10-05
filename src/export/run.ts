import { useStore } from '../store/store';
import { flash, safeName, saveBlob } from '../store/persistence';
import { buildPptx } from './pptx';

declare global {
  interface Window {
    native?: {
      printToPDF: (suggestedName: string) => Promise<string | null>;
      openReady?: () => Promise<{ path?: string; name?: string; text?: string; error?: string }[]>;
      onOpenFile?: (cb: (file: { path?: string; name?: string; text?: string; error?: string }) => void) => void;
      writeFile?: (path: string, text: string) => Promise<{ ok: boolean; error?: string }>;
    };
  }
}

// Wait for React to commit and the browser to lay out. rAF is paused in background tabs,
// so fall back to a timer (layout is still computed synchronously when measured).
const frame = () => new Promise<void>((r) => {
  const done = () => { clearTimeout(t); r(); };
  const t = setTimeout(done, 100);
  requestAnimationFrame(() => requestAnimationFrame(done));
});

/** Mount the 1:1 print DOM and wait until fonts, images and layout are ready. */
async function mountExportStage(mode: 'print' | 'measure'): Promise<HTMLElement> {
  const st = useStore.getState();
  st.stopEditing();
  useStore.setState({ exportMode: mode, selection: [] });
  await frame();
  await document.fonts.ready;
  const root = document.getElementById('print-root')!;
  // img.decode() can stay pending in background tabs: skip loaded images and cap the wait.
  await Promise.all([...root.querySelectorAll('img')].map((img) => img.complete ? null
    : Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])));
  await frame();
  return root;
}

let busy = false;

export async function exportPdf() {
  if (busy) return;
  busy = true;
  const title = safeName(useStore.getState().deck.title);
  const prevTitle = document.title;
  try {
    await mountExportStage('print');
    if (window.native?.printToPDF) {
      // Desktop app: direct vector PDF via Chromium's printToPDF, saved with a native dialog.
      const path = await window.native.printToPDF(title + '.pdf');
      if (path) flash('PDF 저장됨 — ' + path);
    } else {
      // Browser: print dialog → "PDF로 저장". The document title becomes the default file name.
      document.title = title;
      window.print();
    }
  } catch (e) {
    console.error(e);
    alert('PDF 내보내기 실패: ' + (e as Error).message);
  } finally {
    document.title = prevTitle;
    useStore.setState({ exportMode: null });
    busy = false;
  }
}

const PPTX_TYPES = [{
  description: 'PowerPoint',
  accept: { 'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'] },
}];

export async function exportPptx() {
  if (busy) return;
  busy = true;
  const st0 = useStore.getState();
  const name = safeName(st0.deck.title) + '.pptx';
  // Ask for the destination first, while we still have the user gesture.
  let handle: any = null;
  const w = window as any;
  if (w.showSaveFilePicker) {
    try {
      handle = await w.showSaveFilePicker({ suggestedName: name, types: PPTX_TYPES });
    } catch (e: any) {
      if (e?.name === 'AbortError') { busy = false; return; }
    }
  }
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = 'PowerPoint 파일 만드는 중…';
  document.body.appendChild(toast);
  try {
    const root = await mountExportStage('measure');
    const st = useStore.getState();
    const blob = await buildPptx(st.deck, st.assets, root);
    useStore.setState({ exportMode: null });
    if (handle) {
      const ws = await handle.createWritable();
      await ws.write(blob);
      await ws.close();
      flash('PPTX 저장됨 — ' + handle.name);
    } else if (await saveBlob(blob, name)) flash('PPTX 저장됨 — ' + name);
  } catch (e) {
    console.error(e);
    alert('PPTX 내보내기 실패: ' + (e as Error).message);
  } finally {
    toast.remove();
    useStore.setState({ exportMode: null });
    busy = false;
  }
}
