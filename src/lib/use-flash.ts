'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { looksLikeError } from './flash-kind.ts';

/**
 * 頁面訊息（給 `<Toast>` 用）—— **全站唯一一份**。
 *
 * ============================================================
 * 【為什麼要收成一支】
 *
 * 2026-09-23 之前有 20 頁各自寫一份 `flash()`，逾時從 2.5 到 5 秒不等，
 * 而且大多數**錯誤跟成功長得一樣**：綠色、幾秒就消失。
 * 房務支出那次半年沒人發現，就是錯誤訊息 2.5 秒消失在畫面外。
 *
 * 【規則】
 *   · 成功／提示 → 綠色，`okMs` 之後自己走
 *   · 錯誤（`looksLikeError()`）→ 紅色，**留到按掉**（Toast 的 error 模式）
 *   · 靠內容判斷，呼叫點不用改（理由見 flash-kind.ts）；要硬指定用 `flashErr()`
 *
 * ★ 新訊息會取消上一句的計時器 —— 不然「已儲存」的 2.5 秒到了會把
 *   後面那句錯誤一起清掉。
 *
 * 用法：
 *   const { msg, msgErr, flash, flashErr, clearMsg } = useFlash();
 *   <Toast msg={msg} error={msgErr} onClose={clearMsg} />
 */
export function useFlash(okMs = 2500) {
  const [msg, setMsg] = useState('');
  const [msgErr, setMsgErr] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearMsg = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setMsg('');
  }, []);

  const flash = useCallback((t: string, isErr?: boolean) => {
    const bad = isErr ?? looksLikeError(t);
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setMsg(t); setMsgErr(bad);
    if (!bad) timer.current = setTimeout(() => { timer.current = null; setMsg(''); }, okMs);
  }, [okMs]);

  const flashErr = useCallback((t: string) => flash(t, true), [flash]);

  // 元件卸載時把計時器收掉，不然會對已經不存在的元件 setState
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { msg, msgErr, flash, flashErr, clearMsg };
}
