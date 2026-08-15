'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';

/**
 * 登入。
 *
 * ============================================================
 * 【欄位要讓密碼管理員認得出來】
 *
 * 原本兩個 input 沒有 `name`、沒有 `id`、沒有 `autoComplete` ——
 * 瀏覽器只能用猜的:有時不問你要不要儲存,有時把 email 填到密碼欄。
 *
 * 這三個屬性是密碼管理員唯一的線索:
 *
 *     autoComplete="username"          ← 這格是帳號,存起來
 *     autoComplete="current-password"  ← 這格是現有密碼(不是新設的)
 *
 * 寫成 "new-password" 的話 Chrome 會跳「要不要用建議的強密碼」——
 * 在登入頁那是完全錯誤的提示。
 *
 *
 * ============================================================
 * 【上次登入的 email 記起來】
 *
 * 這就是「登入過會有印記」的那個東西 —— 一半是瀏覽器的密碼管理員,
 * 一半可以由我們自己做得更可靠。
 *
 * 只記 email，**絕對不記密碼**。localStorage 是明文的,
 * 任何一支能跑 JS 的擴充套件都讀得到。
 *
 * 共用電腦的情況:email 是「誰在用這台」的線索,不是秘密 ——
 * 而且旁邊有一顆「換人登入」可以清掉。
 *
 *
 * ============================================================
 * 【密碼的眼睛】（2026-08-15 使用者要求）
 *
 * 打錯密碼最常見的原因是**看不到自己打了什麼**,尤其是手機上
 * 大小寫混英數的密碼。看得到就少一次「帳號或密碼錯誤」。
 *
 * 按下去焦點要留在輸入框裡 —— 跳掉的話使用者要再點一次才能繼續打,
 * 而多數人會以為是壞了。
 *
 *
 * ============================================================
 * 【大寫鎖定提示】
 *
 * 密碼看不到的時候,CapsLock 開著是最難查的錯:每個字都對,
 * 就是登不進去。而錯誤訊息只會說「帳號或密碼錯誤」。
 */

/** 上次登入的 email。只有 email —— 密碼永遠不落地 */
const LAST_EMAIL = 'lastEmail';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  /** 有記住的 email 才顯示「換人登入」—— 沒東西可清的按鈕只是雜訊 */
  const [remembered, setRemembered] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  /*
   * 掛載後才讀 localStorage —— 伺服器端算不出來，
   * 直接用會 hydration 不一致（畫面閃一下再改掉）。
   */
  useEffect(() => {
    let saved = '';
    try { saved = localStorage.getItem(LAST_EMAIL) ?? ''; } catch { /* 無痕模式會丟例外 */ }
    if (saved) {
      setEmail(saved);
      setRemembered(true);
      // 帳號已經填好了，游標直接落在密碼 —— 少一次點擊
      pwRef.current?.focus();
    } else {
      emailRef.current?.focus();
    }
  }, []);

  function forgetEmail() {
    try { localStorage.removeItem(LAST_EMAIL); } catch { /* 同上 */ }
    setEmail(''); setPassword(''); setRemembered(false);
    emailRef.current?.focus();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(), password,
    });
    setLoading(false);
    if (error) {
      /*
       * 不區分「查無此帳號」與「密碼錯」。
       *
       * 分開講的話,任何人都可以拿這一頁確認某個 email 是不是我們的員工 ——
       * 那是免費送出去的名單。
       *
       * 代價是真的打錯帳號的人要自己看一眼,所以下面把密碼清空、
       * 焦點留在密碼欄:多數情況錯的是密碼。
       */
      setError('帳號或密碼錯誤');
      setPassword('');
      pwRef.current?.focus();
      return;
    }
    try { localStorage.setItem(LAST_EMAIL, email.trim()); } catch { /* 無痕模式 */ }
    router.push('/reviews');
    router.refresh();
  }

  const inp = 'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-[15px] '
    + 'focus:outline-none focus:ring-2 focus:ring-mor-slate focus:border-mor-slate '
    + 'disabled:bg-gray-50 disabled:text-gray-400';

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold">安幸上工</h1>
          <p className="text-gray-500 mt-2 text-sm">內部管理系統</p>
        </div>

        <form onSubmit={onSubmit}
          className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium mb-1">Email</label>
            <input
              ref={emailRef}
              id="email" name="email" type="email"
              /*
                手機鍵盤:email 型別本來就會給 @ 鍵,但 autoCapitalize 要關掉 ——
                iOS 預設會把第一個字母變大寫,而 Email 是大小寫敏感的登入鍵。
              */
              autoComplete="username"
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              inputMode="email"
              required disabled={loading}
              value={email} onChange={(e) => setEmail(e.target.value)}
              className={inp} />
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-1">
              <label htmlFor="password" className="block text-sm font-medium">密碼</label>
              {remembered && (
                <button type="button" onClick={forgetEmail}
                  className="text-xs text-gray-400 hover:text-mor-slate underline">
                  換人登入
                </button>
              )}
            </div>
            <div className="relative">
              <input
                ref={pwRef}
                id="password" name="password"
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                required disabled={loading}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                /*
                  CapsLock 要在按鍵事件裡讀 —— 沒有辦法「查詢目前狀態」，
                  只能在使用者按下任何一鍵時問一次。
                */
                onKeyUp={(e) => setCaps(e.getModifierState('CapsLock'))}
                onKeyDown={(e) => setCaps(e.getModifierState('CapsLock'))}
                onBlur={() => setCaps(false)}
                className={`${inp} pr-11`} />
              <button
                type="button"
                onClick={() => {
                  setShow((v) => !v);
                  // 焦點留在輸入框,不然使用者要再點一次才能繼續打 ——
                  // 而多數人會以為是壞了
                  pwRef.current?.focus();
                }}
                aria-label={show ? '隱藏密碼' : '顯示密碼'}
                aria-pressed={show}
                title={show ? '隱藏密碼' : '顯示密碼'}
                tabIndex={-1}   /* Tab 從密碼直接到「登入」,不要卡在這顆眼睛上 */
                className="absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center
                           justify-center rounded-lg text-gray-400 hover:text-mor-slate
                           hover:bg-mor-sand/70 transition-colors">
                {show ? (
                  // 劃掉的眼睛 = 「按了會關掉」。用同一顆眼睛加斜線,
                  // 而不是換成別的圖示 —— 換圖示看不出兩個狀態是同一件事
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
                    strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                    <path d="M3 3l18 18" />
                    <path d="M10.6 10.6a2 2 0 002.8 2.8" />
                    <path d="M9.4 5.2A9.4 9.4 0 0112 5c5 0 9 5 9 7a12 12 0 01-2.4 3.1" />
                    <path d="M6.3 6.7C3.9 8.2 3 10.6 3 12c0 2 4 7 9 7a9 9 0 003.6-.7" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
                    strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                    <path d="M3 12s4-7 9-7 9 7 9 7-4 7-9 7-9-7-9-7z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                )}
              </button>
            </div>

            {/*
              大寫鎖定。密碼看不到的時候，這是最難查的錯:
              每個字都對，就是登不進去，而錯誤訊息只會說「帳號或密碼錯誤」。
            */}
            {caps && !show && (
              <p className="mt-1.5 text-xs text-amber-700 flex items-center gap-1">
                <span aria-hidden>⇪</span> 大寫鎖定開著
              </p>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button type="submit" disabled={loading || !email || !password}
            className="w-full rounded-lg bg-mor-slate text-white py-2.5 font-medium
                       hover:bg-mor-slatedark disabled:opacity-50 transition-colors">
            {loading ? '登入中…' : '登入'}
          </button>
        </form>

        <p className="text-center text-xs text-gray-400 mt-4">
          忘記密碼請找總經理重設 —— 系統沒有自助重設。
        </p>
      </div>
    </div>
  );
}
