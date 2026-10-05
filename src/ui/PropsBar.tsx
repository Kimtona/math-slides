import { useEffect, useReducer } from 'react';
import type { ImageElement, LineElement, ShapeElement, SlideElement, TextElement } from '../model/types';
import { useStore } from '../store/store';
import { getActiveEditor, onActiveEditorChange } from '../editor/active';
import { Btn, ColorButton, Icons, NumberField, Popover, Sep, WidthButton } from './controls';
import { themeColorOf } from '../model/theme';
import { DEFAULT_TEXT_COLOR, emptyDoc, shapeTextStyle } from '../model/defaults';
import { cropOf, isCropped, sourceRect } from '../model/imageCrop';
import { SLIDE_H, SLIDE_W } from '../model/types';
import { activeTextColor, markActive, setTextStyle, toggleList, toggleMark } from './textFormat';
import { HighlightButton, PaletteColorButton, ShapeFillButton, TextColorButton, ThemeColorButton } from './TextColorPalette';
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

function TextProps({ el, editing, box = true }: { el: TextElement; editing: boolean; box?: boolean }) {
  useEditorTick();
  const ed = editing ? getActiveEditor() : null;
  // A line sized with #/##/###/#### has its own size; while the caret is on it, the field edits that line.
  const inCode = !!ed?.isActive('codeBlock');
  // Inside a Code Block the field shows/edits that block's own size (older blocks without one render at .85em of the box size).
  const codeSize = inCode ? (ed!.getAttributes('codeBlock').fontSize as number | null) ?? Math.round(el.style.fontSize * 0.85 * 2) / 2 : undefined;
  const lineSize = inCode ? codeSize : (ed?.getAttributes('paragraph').fontSize as number | undefined);
  const size = lineSize ?? el.style.fontSize;
  const setSize = (v: number) => {
    if (ed && inCode) ed.chain().focus().updateAttributes('codeBlock', { fontSize: v }).run();
    else if (ed && lineSize) ed.chain().focus().updateAttributes('paragraph', { fontSize: v }).run();
    else setTextStyle({ fontSize: v });
  };
  return (
    <>
      <Btn title="글자 작게" onClick={() => setSize(Math.max(6, size - 2))}>−</Btn>
      <NumberField value={size} min={6} max={300} title={inCode ? '코드 블록 글자 크기 (px)' : lineSize ? '이 줄의 글자 크기 (px)' : '글자 크기 (px)'} onChange={setSize} />
      <Btn title="글자 크게" onClick={() => setSize(size + 2)}>+</Btn>
      <Sep />
      <Btn title="굵게 ⌘B" active={markActive('bold', el, editing)} onClick={() => toggleMark('bold')}><b>B</b></Btn>
      <Btn title="기울임 ⌘I" active={markActive('italic', el, editing)} onClick={() => toggleMark('italic')}><i style={{ fontFamily: 'serif' }}>I</i></Btn>
      <Btn title="밑줄 ⌘U" active={markActive('underline', el, editing)} onClick={() => toggleMark('underline')}><u>U</u></Btn>
      <Btn title="취소선" active={markActive('strike', el, editing)} onClick={() => toggleMark('strike')}><s>S</s></Btn>
      <TextColorButton value={activeTextColor(el, editing)} />
      <HighlightButton value={activeTextColor(el, editing, 'highlight')} />
      <Btn title="인라인 코드 (Inline Code)" active={markActive('code', el, editing)} onClick={() => toggleMark('code')}>{Icons.code}</Btn>
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
      {box && <ColorButton title="상자 배경" label={<span className="small-label">배경</span>} allowNone value={el.style.fill} onChange={(c) => setTextStyle({ fill: c })} />}
    </>
  );
}

/** A shape being text-edited, seen through the text-box toolbar (only its text style/doc are read). */
const shapeAsText = (el: ShapeElement): TextElement => ({ ...el, type: 'text', doc: el.doc ?? emptyDoc(), style: shapeTextStyle(el) } as unknown as TextElement);

function ShapeProps({ el }: { el: ShapeElement }) {
  const upd = (fn: (d: ShapeElement) => void) => useStore.getState().updateElements([el.id], (d) => fn(d as ShapeElement));
  return (
    <>
      <ShapeFillButton value={el.fill} onChange={(c) => upd((d) => { d.fill = c; })} />
      <PaletteColorButton title="테두리 (Border)" label={<span className="small-label">테두리</span>} noneLabel="테두리 없음"
        value={el.stroke} onChange={(c) => upd((d) => { d.stroke = c; })} onNone={() => upd((d) => { d.stroke = null; })} />
      <WidthButton title="테두리 두께" allowNone value={el.stroke ? el.strokeWidth : null}
        onChange={(w) => upd((d) => {
          if (w === null) { d.stroke = null; return; }
          d.strokeWidth = w;
          if (!d.stroke) d.stroke = DEFAULT_TEXT_COLOR; // picking a width on a borderless shape adds a border
        })} />
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
      <WidthButton title="선 두께" value={el.strokeWidth} onChange={(w) => w && upd((d) => { d.strokeWidth = w; })} />
      <Btn title="점선" active={el.dashed} onClick={() => upd((d) => { d.dashed = !d.dashed; })}>┄</Btn>
      <Btn title="시작 화살표" active={el.arrowStart} onClick={() => upd((d) => { d.arrowStart = !d.arrowStart; })}>←</Btn>
      <Btn title="끝 화살표" active={el.arrowEnd} onClick={() => upd((d) => { d.arrowEnd = !d.arrowEnd; })}>→</Btn>
    </>
  );
}

function ImageProps({ el }: { el: ImageElement }) {
  const asset = useStore((s) => s.assets[el.assetId]);
  const cropping = useStore((s) => s.cropEditId === el.id);
  const st = useStore.getState();
  const c = cropOf(el);
  const resetCrop = () => {
    // Show the whole image again at its current scale, kept on the slide.
    const R = sourceRect(el, c);
    const k = Math.min(1, SLIDE_W / R.w, SLIDE_H / R.h);
    const w = R.w * k, h = R.h * k;
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
    st.updateElements([el.id], (d) => {
      const i = d as ImageElement;
      i.crop = undefined;
      i.w = Math.round(w); i.h = Math.round(h);
      i.x = Math.round(Math.min(Math.max(cx - w / 2, 0), SLIDE_W - w));
      i.y = Math.round(Math.min(Math.max(cy - h / 2, 0), SLIDE_H - h));
    });
  };
  if (cropping) {
    return (
      <>
        <Btn wide className="active" title="크롭 완료 (Esc / Enter / 바깥 클릭)" onClick={() => st.exitCrop()}>✓ 크롭 완료</Btn>
        <Btn wide title="크롭 해제 — 원본 전체 보기" onClick={() => { st.exitCrop(); resetCrop(); }}>크롭 해제</Btn>
        <span className="hint">드래그 = 이미지 이동 · 휠/핀치·파란 점 = 확대/축소 · 흰 핸들 = 크롭 영역</span>
      </>
    );
  }
  return (
    <>
      <Btn wide title="크롭 편집 (더블클릭 / Enter)" onClick={() => st.enterCrop(el.id)}>크롭</Btn>
      {isCropped(el.crop) && <Btn wide title="크롭 해제 — 원본 전체 보기" onClick={resetCrop}>크롭 해제</Btn>}
      <Btn wide title="원본 비율로 되돌리기" onClick={() => {
        if (!asset) return;
        st.updateElements([el.id], (d) => { d.h = Math.round(d.w * (c.h * asset.height) / (c.w * asset.width)); });
      }}>원본 비율</Btn>
      {el.caption === undefined
        ? <Btn wide title="이미지 캡션 추가" onClick={() => st.updateElements([el.id], (d) => { (d as ImageElement).caption = ''; })}>Caption</Btn>
        : <Btn wide className="active" title="이미지 캡션 삭제" onClick={() => st.updateElements([el.id], (d) => { delete (d as ImageElement).caption; })}>Remove Caption</Btn>}
      <span className="hint">드래그 = 비율 유지 · ⌥ Option = 자유 변형 · ⇧ Shift = 크롭 · 더블클릭 = 크롭 편집</span>
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
  const deck = useStore((s) => s.deck);
  const els = slide.elements.filter((e) => selection.includes(e.id));
  const one: SlideElement | undefined = els.length === 1 ? els[0] : undefined;

  return (
    <div className="propsbar">
      {!els.length && (
        <>
          <span className="small-label">슬라이드 {slideIdx + 1} / {total}</span>
          <Sep />
          <ThemeColorButton value={themeColorOf(deck)} onChange={(c) => useStore.getState().commit((d) => { d.themeColor = c; })} />
          <PaletteColorButton title="슬라이드 배경" label={<span className="small-label">배경색</span>} value={slide.background}
            onChange={(c) => useStore.getState().commit((d) => { d.slides[slideIdx].background = c; })} />
          <span className="hint">빈 곳 클릭 → 텍스트 · 텍스트에서 <kbd>/math</kbd> → 수식 · 이미지는 끌어다 놓기 / ⌘V</span>
        </>
      )}
      {one?.type === 'text' && <TextProps el={one} editing={editingId === one.id} />}
      {one?.type === 'shape' && editingId === one.id && <><TextProps el={shapeAsText(one)} editing box={false} /><Sep /></>}
      {one?.type === 'shape' && <ShapeProps el={one} />}
      {one?.type === 'line' && <LineProps el={one} />}
      {one?.type === 'image' && <ImageProps el={one} />}
      {els.length > 1 && els.every((e) => e.type === 'text') && (
        <>
          <Btn title="굵게" onClick={() => toggleMark('bold')}><b>B</b></Btn>
          <NumberField value={(els[0] as TextElement).style.fontSize} min={6} max={300} title="글자 크기" onChange={(v) => setTextStyle({ fontSize: v })} />
          <TextColorButton value={(() => {
            const colors = els.map((el) => activeTextColor(el as TextElement, false));
            return colors.every((c) => c === colors[0]) ? colors[0] : null;
          })()} />
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
