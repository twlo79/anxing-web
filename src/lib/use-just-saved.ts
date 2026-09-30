'use client';
import { useCallback, useEffect, useState } from 'react';
import { SAVED_TTL_MS, type SavedMark } from './just-saved.ts';

/**
 * 「剛剛存的那一筆」標黃 45 秒（lib/saved-feedback.ts 的 ③）。
 *
 *   const { markSaved, isJust } = useJustSaved(rows);
 *   // 存成功之後
 *   markSaved(newId);
 *   // 畫清單的時候
 *   <tr {...justRow(isJust(r.id))} className={isJust(r.id) ? SAVED_HL : ''}>
 *
 * @param watch 清單本身（rows）。標記是在 load() **之前**設的 ——
 *   那一列要等清單換過來才畫得出來，所以捲過去要等它變了再捲一次（訂單頁踩過）。
 *
 * ★ 45 秒後自己收掉；重新整理就沒了（只在記憶體裡）。
 */
export function useJustSaved(watch?: unknown) {
  const [mark, setMark] = useState<SavedMark>(null);

  useEffect(() => {
    if (!mark) return;
    const left = Math.max(0, SAVED_TTL_MS - (Date.now() - mark.at));
    const t = setTimeout(() => setMark(null), left);
    return () => clearTimeout(t);
  }, [mark]);

  // 捲到那一列。等一下再捲：清單重新畫好之後 data-just-saved 那一列才存在
  useEffect(() => {
    if (!mark || typeof document === 'undefined') return;
    const t = setTimeout(() => {
      document.querySelector('[data-just-saved="1"]')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
    return () => clearTimeout(t);
  }, [mark, watch]);

  const markSaved = useCallback((id: string | number | null | undefined) => {
    if (id == null || id === '') return;
    setMark({ id: String(id), at: Date.now() });
  }, []);

  const isJust = useCallback(
    (id: string | number | null | undefined) => !!mark && id != null && mark.id === String(id),
    [mark]);

  const clearSaved = useCallback(() => setMark(null), []);

  return { mark, markSaved, isJust, clearSaved };
}
