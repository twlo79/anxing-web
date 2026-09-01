'use client';
import { useCallback, useRef, useState } from 'react';

/**
 * 「這個動作正在跑，不要再按」的閘門。
 *
 * ============================================================
 * 【為什麼要有這支】（2026-09-01）
 *
 * 稽核紀錄上出現同一秒鐘的三筆訂單 ＋ 三筆押金，操作人與金額完全相同:
 *
 *     14:30  唐  訂單  Ashutosh Shirsat $32000  新增
 *     14:30  唐  押金  Ashutosh Shirsat $20000  新增
 *     14:30  唐  訂單  Ashutosh Shirsat $32000  新增   ← 同一筆按了三次
 *     …
 *
 * 短租頁的儲存鈕是 `<button onClick={save}>`，**沒有 disabled、沒有旗標**，
 * 而 `save()` 是 async 且中間有五、六次 await（建訂單 → 查子訂單 →
 * 寫加費 → 建押金 → 重新載入）。
 *
 * ★ 按第二下的時候第一輪還停在某個 await 上，於是**兩輪各跑一次完整流程**。
 *   `order_key` 用 `Date.now()` 組，兩次的毫秒不同 → 唯一索引也擋不住。
 *
 * ★★ 事後要清很麻煩:訂單、押金、加費子單三張表都要一起刪，
 *   而且刪錯一筆就變成「有押金沒訂單」。**擋在按下去的那一刻最便宜。**
 *
 * ============================================================
 * 【★★★ 為什麼用 ref 不是只用 state】
 *
 * `useState` 的更新是**非同步**的 —— 快速連點三下時，三次 handler
 * 都可能在 React 重繪之前跑完，三次都讀到 `saving === false`。
 *
 * `useRef` 的 `.current` 是**同步**的:第一次 handler 一進去就設成 true，
 * 第二次立刻讀得到。
 *
 * ★ 所以兩個都要:
 *     ref   → 擋住實際執行（同步、可靠）
 *     state → 讓按鈕變灰、顯示「儲存中⋯」（畫面需要重繪才看得到）
 *
 * ★★ 只用 state 的話按鈕會變灰，但**第一下與第二下之間那一瞬間擋不住**——
 *   而那正好是連點會發生的地方。
 *
 * ============================================================
 * 用法：
 *
 *     const [save, saving] = useOnce(async () => {
 *       await supabase.from('orders').insert(...);
 *     });
 *
 *     <button onClick={save} disabled={saving}>
 *       {saving ? '儲存中⋯' : '儲存'}
 *     </button>
 *
 * ★ `disabled` **還是要寫**。閘門擋得住重複執行，但按鈕不變灰的話
 *   使用者不知道系統在做事，於是他會再按 —— 擋住了，但他以為壞了。
 */
export function useOnce<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown>,
): [(...args: A) => Promise<void>, boolean] {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (...args: A) => {
    if (running.current) return;      // ← 同步閘門，這一行就是全部的重點
    running.current = true;
    setBusy(true);
    try {
      await fn(...args);
    } finally {
      /*
       * ★★ `finally` 不能省。丟例外時沒有解鎖的話，
       *   那顆按鈕**從此按不動** —— 而使用者看到的是「按了沒反應」，
       *   比重複送出更難查。
       */
      running.current = false;
      setBusy(false);
    }
  }, [fn]);

  return [run, busy];
}
