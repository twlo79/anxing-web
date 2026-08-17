'use client';
import { useEffect, useRef } from 'react';

/**
 * 「用網址直接開到某一筆」。
 *
 * ============================================================
 * 【為什麼不是「篩選到那一筆」】（2026-08-16）
 *
 * 直覺的做法是帶一個關鍵字讓列表篩出那一筆。不行，因為:
 *
 *   · 那筆可能不在目前的日期範圍（營收看 7 月，訂單頁預設看本月）
 *   · 那筆可能在第 3 頁
 *   · 篩選會被記住,使用者下次打開訂單頁看到的是被篩過的清單而不知道為什麼
 *
 * 所以是**直接查那一筆，直接開編輯視窗**。列表維持原樣 ——
 * 他關掉視窗之後看到的還是他熟悉的那一頁。
 *
 *
 * ============================================================
 * 【為什麼用 window.location 不用 useSearchParams】
 *
 * `useSearchParams()` 會讓整頁在建置時要求包一層 Suspense，
 * 漏了的話是**建置期才爆**的錯誤 —— 而這個專案的 build 跑在 CI，
 * 錯誤要等推上去才看得到。
 *
 * 這裡只在掛載後讀一次，`window.location.search` 就夠了。
 *
 *
 * ============================================================
 * 【讀完要把參數清掉】
 *
 * 不清的話重新整理會再開一次。而使用者按 F5 通常正是因為
 * 他想把那個視窗弄掉。
 *
 * 用 `replaceState` 不是 `push` —— 這不是一次導覽，
 * push 的話上一頁會回到「同一頁但視窗開著」。
 */
export function useOpenFromUrl<T>(
  /** 網址參數名。例如 'order' → `/shortterm?order=<id>` */
  param: string,
  /** 拿 id 去查那一筆。查不到回 null */
  fetchOne: (id: string) => Promise<T | null>,
  /** 查到之後做什麼（通常是 openEdit） */
  onFound: (row: T) => void,
) {
  /*
   * 只跑一次。
   *
   * 不擋的話 `onFound` 每次 render 都是新的函式參考，
   * effect 會重跑 —— 而重跑的後果是**使用者關掉的視窗自己又開起來**。
   * 那種 bug 看起來像鬼打牆,而且沒有錯誤訊息。
   */
  const done = useRef(false);

  useEffect(() => {
    if (done.current || typeof window === 'undefined') return;
    const id = new URLSearchParams(window.location.search).get(param);
    if (!id) return;
    done.current = true;

    // 先清網址再查 —— 查詢可能慢，而使用者在這段時間按 F5 就會開兩次
    const url = new URL(window.location.href);
    url.searchParams.delete(param);
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);

    (async () => {
      const row = await fetchOne(id);
      // 查不到就安靜結束。那筆可能已刪除,而彈一個錯誤對「從別頁點過來」
      // 的人沒有幫助 —— 他看到的會是列表,那本來就是合理的落點
      if (row) onFound(row);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [param]);
}
