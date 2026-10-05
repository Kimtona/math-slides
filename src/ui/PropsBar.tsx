import { useEffect, useReducer } from 'react';
import type { ImageElement, LineElement, ShapeElement, SlideElement, TextElement } from '../model/types';
import { useStore } from '../store/store';
import { getActiveEditor, onActiveEditorChange } from '../editor/active';
import { Btn, ColorButton, Icons, NumberField, Popover, Sep } from './controls';
import { markActive, setTextColor, setTextStyle, toggleList, toggleMark } from './textFormat';
import { alignSelection, distributeSelection } from '../canvas/arrange';
import { duplicateSelection } from '../canvas/insert';

/** Re-render on every transaction of the active editor (for B/I/U state). */
function useEditorTick() {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    let off: (() => void) | null = null;
    const attach = () => {
      off?.();
      const ed = getActiveEditor();
      if (ed) {
        ed.on('transaction', tick);
        off = () => ed.off('transaction', tick);
      } else off = null;
      tick();
    };
    attach();
    const un = onActiveEditorChange(attach);
    return () => { un(); off?.(); };
  }, []);
}

function TextProps({ el, editing }: { el: TextElement; editing: boolean }) {
  useEditorTick();
  const ed = editing ? getActiveEditor() : null;
  const size = el.style.fontSize;
  return (
    <>
      <Btn title="글자 작게" onClick={() => setTextStyle({ fontSize: Math.max(6, size - 2) })}>−</Btn>
      <NumberField value={size} min={6} max={300} title="글자 크기 (px)" onChange={(v) => setTextStyle({ fontSize: v })} />
      <Btn title="글자 크게" onClick={() => setTextStyle({ fontSize: size + 2 })}>+</Btn>
      <Sep />
      <Btn title="굵게 ⌘B" active={markActive('bold', el, editing)} onClick={() => toggleMark('bold')}><b>B</b></Btn>
      <Btn title="기울임 ⌘I" active={markActive('italic', el, editing)} onClick={() => toggleMark('italic')}><i style={{ fontFamily: 'serif' }}>I</i></Btn>
      <Btn title="밑줄 ⌘U" active={markActive('underline', el, editing)} onClick={() => toggleMark('underline')}><u>U</u></Btn>
      <Btn title="취소선" active={markActive('strike', el, editing)} onClick={() => toggleMark('strike')}><s>S</s></Btn>
      <ColorButton title="글자 색 (선택한 글자, 또는 전체)" label={<span className="a-glyph">A</span>}
        value={(ed?.getAttributes('textStyle').color as string) ?? el.style.color}
        onChange={(c) => c && setTextColor(c)} />
      <Sep />
      <Btn title="왼쪽 정렬" active={el.style.align === 'left'} onClick={() => setTextStyle({ align: 'left' })}>{Icons.tAlignL}</Btn>
      <Btn title="가운데 정렬" active={el.style.align === 'center'} onClick={() => setTextStyle({ align: 'center' })}>{Icons.tAlignC}</Btn>
      <Btn title="오른쪽 정렬" active={el.style.align === 'right'} onClick={() => setTextStyle({ align: 'right' })}>{Icons.tAlignR}</Btn>
      <Sep />
      <Btn title="글머리 기호 ( - 입력)" active={!!ed?.isActive('bulletList')} onClick={() => toggleList('bullet')}>{Icons.list}</Btn>
      <Btn title="번호 목록 ( 1. 입력)" active={!!ed?.isActive('orderedList')} onClick={() => toggleList('ordered')}>{Icons.olist}</Btn>
      <Popover title="줄 간격" button={<span className="small-label">↕ {el.style.lineHeight}</span>}>
        {(close) => (
          <div className="menu">
            {[1.0, 1.15, 1.25, 1.35, 1.5, 1.75, 2.0].map((v) => (
              <div key={v} className={`menu-item${v === el.style.lineHeight ? ' sel' : ''}`} onClick={() => { setTextStyle({ lineHeight: v }); close(); }}>{v}</div>
            ))}
          </div>
        )}
      </Popover>
      <ColorButton title="상자 배경" label={<span className="small-label">배경</span>} allowNone value={el.style.fill} onChange={(c) => setTextStyle({ fill: c })} />
    </>
  );
}

function ShapeProps({ el }: { el: ShapeElement }) {
  const upd = (fn: (d: ShapeElement) => void) => useStore.getState().updateElements([el.id], (d) => fn(d as ShapeElement));
  return (
    <>
      <ColorButton title="채우기" label={<span className="small-label">채우기</span>} allowNone value={el.fill} onChange={(c) => upd((d) => { d.fill = c; })} />
      <ColorButton title="테두리" label={<span className="small-label">테두리</span>} allowNone value={el.stroke} onChange={(c) => upd((d) => { d.stroke = c; })} />
      <NumberField value={el.strokeWidth} min={0.5} max={40} step={0.5} title="테두리 두께" onChange={(v) => upd((d) => { d.strokeWidth = v; })} />
      <Sep />
      <Btn title="사각형" active={el.shape === 'rect'} onClick={() => upd((d) => { d.shape = 'rect'; })}>▭</Btn>
      <Btn title="둥근 사각형" active={el.shape === 'roundRect'} onClick={() => upd((d) => { d.shape = 'roundRect'; })}>▢</Btn>
      <Btn title="타원" active={el.shape === 'ellipse'} onClick={() => upd((d) => { d.shape = 'ellipse'; })}>◯</Btn>
      {el.shape === 'roundRect' && <>
        <span className="small-label">모서리</span>
        <NumberField value={el.radius} min={0} max={400} title="모서리 반경" onChange={(v) => upd((d) => { d.radius = v; })} />
      </>}
    </>
  );
}

function LineProps({ el }: { el: LineElement }) {
  const upd = (fn: (d: LineElement) => void) => useStore.getState().updateElements([el.id], (d) => fn(d as LineElement));
  return (
    <>
      <ColorButton title="선 색" label={<span className="small-label">선</span>} value={el.stroke} onChange={(c) => c && upd((d) => { d.stroke = c; })} />
      <NumberField value={el.strokeWidth} min={0.5} max={40} step={0.5} title="선 두께" onChange={(v) => upd((d) => { d.strokeWidth = v; })} />
      <Btn title="점선" active={el.dashed} onClick={() => upd((d) => { d.dashed = !d.dashed; })}>┄</Btn>
      <Btn title="시작 화살표" active={el.arrowStart} onClick={() => upd((d) => { d.arrowStart = !d.arrowStart; })}>←</Btn>
      <Btn title="끝 화살표" active={el.arrowEnd} onClick={() => upd((d) => { d.arrowEnd = !d.arrowEnd; })}>→</Btn>
    </>
  );
}

function ImageProps({ el }: { el: ImageElement }) {
  const asset = useStore((s) => s.assets[el.assetId]);
  return (
    <>
      <Btn wide title="원본 비율로 되돌리기" onClick={() => {
        if (!asset) return;
        useStore.getState().updateElements([el.id], (d) => { d.h = Math.round(d.w * asset.height / asset.width); });
      }}>원본 비율</Btn>
      <span className="hint">모서리 드래그 = 비율 유지 · Shift = 자유 변형</span>
    </>
  );
}

function ArrangeProps({ count }: { count: number }) {
  const st = useStore.getState();
  return (
    <>
      <Popover title="정렬" button={<span className="small-label">{Icons.alignC} 정렬</span>}>
        {(close) => (
          <div className="align-grid" onClick={close}>
            <div className="menu-caption">{count > 1 ? '선택한 개체끼리' : '슬라이드 기준'}</div>
            <Btn title="왼쪽" onClick={() => alignSelection('left')}>{Icons.alignL}</Btn>
            <Btn title="가로 가운데" onClick={() => alignSelection('hcenter')}>{Icons.alignC}</Btn>
            <Btn title="오른쪽" onClick={() => alignSelection('right')}>{Icons.alignR}</Btn>
            <Btn title="위" onClick={() => alignSelection('top')}>{Icons.alignT}</Btn>
            <Btn title="세로 가운데" onClick={() => alignSelection('vcenter')}>{Icons.alignM}</Btn>
            <Btn title="아래" onClick={() => alignSelection('bottom')}>{Icons.alignB}</Btn>
            {count >= 3 && <>
              <Btn title="가로 간격 균등" onClick={() => distributeSelection('h')}>{Icons.distH}</Btn>
              <Btn title="세로 간격 균등" onClick={() => distributeSelection('v')}>{Icons.distV}</Btn>
            </>}
          </div>
        )}
      </Popover>
      <Btn title="맨 앞으로 ⌘⇧]" onClick={() => st.reorderSelection('front')}>{Icons.front}</Btn>
      <Btn title="맨 뒤로 ⌘⇧[" onClick={() => st.reorderSelection('back')}>{Icons.back}</Btn>
      <Btn title="복제 ⌘D" onClick={duplicateSelection}>{Icons.copy}</Btn>
      <Btn title="삭제 ⌫" onClick={() => st.deleteSelection()}>{Icons.trash}</Btn>
    </>
  );
}

export function PropsBar() {
  const selection = useStore((s) => s.selection);
  const editingId = useStore((s) => s.editingId);
  const slide = useStore((s) => s.deck.slides.find((x) => x.id === s.currentSlideId)!);
  const slideIdx = useStore((s) => s.deck.slides.findIndex((x) => x.id === s.currentSlideId));
  const total = useStore((s) => s.deck.slides.length);
  const els = slide.elements.filter((e) => selection.includes(e.id));
  const one: SlideElement | undefined = els.length === 1 ? els[0] : undefined;

  return (
    <div className="propsbar">
      {!els.length && (
        <>
          <span className="small-label">슬라이드 {slideIdx + 1} / {total}</span>
          <Sep />
          <ColorButton title="슬라이드 배경" label={<span className="small-label">배경색</span>} value={slide.background}
            onChange={(c) => useStore.getState().commit((d) => { d.slides[slideIdx].background = c ?? '#ffffff'; })} />
          <span className="hint">빈 곳 클릭 → 텍스트 · 텍스트에서 <kbd>/math</kbd> → 수식 · 이미지는 끌어다 놓기 / ⌘V</span>
        </>
      )}
      {one?.type === 'text' && <TextProps el={one} editing={editingId === one.id} />}
      {one?.type === 'shape' && <ShapeProps el={one} />}
      {one?.type === 'line' && <LineProps el={one} />}
      {one?.type === 'image' && <ImageProps el={one} />}
      {els.length > 1 && els.every((e) => e.type === 'text') && (
        <>
          <Btn title="굵게" onClick={() => toggleMark('bold')}><b>B</b></Btn>
          <NumberField value={(els[0] as TextElement).style.fontSize} min={6} max={300} title="글자 크기" onChange={(v) => setTextStyle({ fontSize: v })} />
        </>
      )}
      {els.length > 0 && (
        <>
          <div className="spacer" />
          <ArrangeProps count={els.length} />
        </>
      )}
    </div>
  );
}
