import type { SlideElement } from '../model/types';
import { canCaption } from '../model/caption';
import { useStore } from '../store/store';
import { addTableCaption, removeTableCaption } from '../editor/tableActions';
import { Btn } from './controls';

const NOUN: Record<SlideElement['type'], string> = { image: '이미지 ', table: '표 ', text: '', shape: '', line: '', emoji: '' };

/** Add / remove the caption of the selected element (one undo step). Tables go through their own edit path so cell editing ends first. */
export function CaptionButton({ el }: { el: SlideElement }) {
  if (!canCaption(el)) return null;
  const noun = NOUN[el.type];
  if (el.caption === undefined) {
    const add = () => (el.type === 'table' ? addTableCaption(el.id) : useStore.getState().updateElements([el.id], (d) => { d.caption = ''; }));
    return <Btn wide title={`${noun}캡션 추가`} onClick={add}>Caption</Btn>;
  }
  const remove = () => (el.type === 'table' ? removeTableCaption(el.id) : useStore.getState().updateElements([el.id], (d) => { delete d.caption; }));
  return <Btn wide className="active" title={`${noun}캡션 삭제`} onClick={remove}>Remove Caption</Btn>;
}
