'use client';
import { useEffect } from 'react';
import { isDragClick } from '@/lib/drag-click';

/**
 * 全站一份：拖曳選字、放開在表單外面時，不讓那一下被當成「點背景關掉」。
 * 規則與理由在 `lib/drag-click.ts`。掛在 (app)/layout.tsx，所有彈窗、抽屜一起受保護 ——
 * 不用每個彈窗各自改（全站有二十幾個「點背景關掉」）。
 *
 * ★ 用 capture 階段在 window 上攔：比任何元件的 onClick 都早，擋下來的 click 不會往下送。
 */
export default function DragClickGuard() {
  useEffect(() => {
    let down: { t: EventTarget | null; x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => { down = { t: e.target, x: e.clientX, y: e.clientY }; };
    const onClick = (e: MouseEvent) => {
      const d = down; down = null;
      if (!d || !(d.t instanceof Node) || !(e.target instanceof Node)) return;
      if (isDragClick({
        sameTarget: d.t === e.target,
        clickContainsDown: e.target.contains(d.t),
        dx: e.clientX - d.x, dy: e.clientY - d.y,
      })) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('click', onClick, true);
    };
  }, []);
  return null;
}
