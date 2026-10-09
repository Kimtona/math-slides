import { useStore } from '../store/store';
import { Btn, Icons, MenuItem, Popover, Sep } from './controls';
import { insertEmoji, insertLine, insertMathBox, insertShape, insertTable, insertTextCenter, pickImages } from '../canvas/insert';
import { loadRecovery, newProject, openProject, restoreRecovered, saveProject } from '../store/persistence';
import { useEffect, useRef, useState } from 'react';
import { createQuickEmojiPanel } from '../editor/quickEmojiPanel';
import { exportPdf, exportPptx } from '../export/run';

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl+';

/** Shown only while work displaced by New/Open is held in the recovery slot; not a list of documents. */
function RecoverWork() {
  const [has, setHas] = useState(false);
  useEffect(() => { loadRecovery().then((r) => setHas(r.length > 0)); }, []);
  return has ? <MenuItem onClick={restoreRecovered}>직전 작업 복구</MenuItem> : null;
}

/** The shared Quick Emojis panel (same user preference as the Callout's) whose picks insert a standalone emoji. */
function QuickEmojiMenu({ close }: { close: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = createQuickEmojiPanel({ onPick: (e) => { close(); insertEmoji(e); }, onMore: close });
    host.current!.append(panel.el);
    return () => { panel.destroy(); panel.el.remove(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={host} className="emoji-tool" />;
}

export function Toolbar() {
  const title = useStore((s) => s.deck.title);
  const canUndo = useStore((s) => s.past.length > 0 || !!s.editingId);
  const canRedo = useStore((s) => s.future.length > 0);
  const saveState = useStore((s) => s.saveState);
  const fileName = useStore((s) => s.fileHandle?.name as string | undefined);

  return (
    <header className="toolbar">
      <div className="tb-left">
        <Popover title="파일" className="file-menu" button={<span className="logo">∑</span>}>
          {(close) => (
            <div className="menu" onClick={close}>
              <MenuItem onClick={newProject}>새 프레젠테이션</MenuItem>
              <RecoverWork />
              <MenuItem onClick={openProject} shortcut={`${MOD}O`}>열기…</MenuItem>
              <MenuItem onClick={() => saveProject()} shortcut={`${MOD}S`}>저장</MenuItem>
              <MenuItem onClick={() => saveProject(true)} shortcut={`${MOD}⇧S`}>다른 이름으로 저장…</MenuItem>
            </div>
          )}
        </Popover>
        <input className="title-input" value={title} spellCheck={false}
          onChange={(e) => useStore.getState().live((d) => { d.title = e.target.value; })}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        <span className="save-state" title={fileName ? `파일: ${fileName}` : '브라우저에 자동 저장됨'}>
          {saveState === 'saved' ? (fileName ? `자동 저장됨 · ${fileName}` : '자동 저장됨') : '저장 중…'}
        </span>
      </div>

      <div className="tb-center">
        <Btn wide title="텍스트 상자 (T) — 또는 빈 곳을 클릭" onClick={insertTextCenter}>{Icons.text}<span>텍스트</span></Btn>
        <Btn wide title="수식 (M) — 텍스트 안에서는 /math" onClick={insertMathBox}><span className="sigma">∑</span><span>수식</span></Btn>
        <Btn wide title="이미지 (I) — 끌어다 놓기·붙여넣기도 가능" onClick={pickImages}>{Icons.image}<span>이미지</span></Btn>
        <Btn wide title="표 — 텍스트 안에서는 /table" onClick={insertTable}><span className="wide-inner"><span>▦</span><span>표</span></span></Btn>
        <Popover title="도형" button={<span className="wide-inner">{Icons.shape}<span>도형</span></span>}>
          {(close) => (
            <div className="menu" onClick={close}>
              <MenuItem onClick={() => insertShape('rect')} shortcut="R">▭ 사각형</MenuItem>
              <MenuItem onClick={() => insertShape('roundRect')}>▢ 둥근 사각형</MenuItem>
              <MenuItem onClick={() => insertShape('ellipse')} shortcut="O">◯ 타원</MenuItem>
              <MenuItem onClick={() => insertLine(false)} shortcut="L">╱ 선</MenuItem>
              <MenuItem onClick={() => insertLine(true)} shortcut="A">→ 화살표</MenuItem>
              <MenuItem onClick={() => insertShape('blockArrow')}>⇨ 두꺼운 화살표</MenuItem>
            </div>
          )}
        </Popover>
        <Popover title="이모지" className="emoji-menu" button={<span className="wide-inner">{Icons.emoji}<span>이모지</span></span>}>
          {(close) => <QuickEmojiMenu close={close} />}
        </Popover>
      </div>

      <div className="tb-right">
        <Btn title={`실행 취소 ${MOD}Z`} disabled={!canUndo} onClick={() => useStore.getState().undo()}>{Icons.undo}</Btn>
        <Btn title={`다시 실행 ${MOD}⇧Z`} disabled={!canRedo} onClick={() => useStore.getState().redo()}>{Icons.redo}</Btn>
        <Sep />
        <Btn wide title="발표 (F5 / ⌘↵)" onClick={() => useStore.setState({ presenting: true })}>{Icons.play}<span>발표</span></Btn>
        <Popover title="내보내기" className="export-menu" button={<span className="wide-inner primary-ish">{Icons.download}<span>내보내기</span></span>}>
          {(close) => (
            <div className="menu" onClick={close}>
              <MenuItem onClick={exportPdf} shortcut={`${MOD}P`}>PDF (.pdf) — 벡터 텍스트·수식</MenuItem>
              <MenuItem onClick={exportPptx} shortcut={`${MOD}E`}>PowerPoint (.pptx) — 편집 가능</MenuItem>
            </div>
          )}
        </Popover>
      </div>
    </header>
  );
}

