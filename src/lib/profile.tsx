'use client';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';

/**
 * 登入者的身分與角色，**全站只查一次**。
 *
 * ============================================================
 * 【原本重複到什麼程度】（2026-08-15 實測）
 *
 * 打開儀表板一次，Network 上是這樣：
 *
 *     auth/v1/user                        × 2   （同時發出）
 *     profiles?select=name,role&id=eq.…   × 1   （layout）
 *     profiles?select=role&id=eq.…        × 1   （dashboard）
 *
 * 同一個人的同一件事，問了四次。而且是**串接的**：
 * 頁面要等 auth 回來才知道 user.id，才能查 profiles，
 * 才敢開始載資料 —— 實測那段是 627ms。
 *
 * 八個頁面各自複製同一段程式（admin / dashboard / deposits / expenses /
 * housekeeping / purchases / shortterm / trash-tab），每換一頁重來一次。
 *
 *
 * ============================================================
 * 【為什麼用 Context 而不是各自快取】
 *
 * 各自快取的話，「快取放哪、什麼時候失效」要在八個地方各想一次，
 * 而且登出換帳號時漏掉的那一個會顯示上一個人的角色 ——
 * 那不是效能問題，是**看到不該看的東西**。
 *
 * 一個 Provider 掛在 (app)/layout 底下，所有頁面共用同一份。
 * 換帳號會整個 layout 重掛，狀態自然跟著換。
 *
 *
 * ============================================================
 * 【loading 要跟 role=null 分得開】
 *
 * 「還在查」跟「查完了，這個人沒有角色」是兩件事。
 * 混在一起的話，頁面在載入期間會閃一下「沒有權限」——
 * 而那句話會讓人以為自己被降權了。
 */

export type Profile = { id: string; name: string | null; role: string | null };

type Ctx = {
  profile: Profile | null;
  /** 方便取用。還沒查完時是 null —— 要區分的話看 loading */
  role: string | null;
  /** 還在查。**不要拿 role === null 當載入中** */
  loading: boolean;
};

const ProfileCtx = createContext<Ctx>({ profile: null, role: null, loading: true });

/*
 * ============================================================
 * 【角色快取】（2026-08-22 新增）
 *
 * 使用者回報:「管家進安幸每次都會讀權限，很不穩，容易有時不小心開放」。
 *
 * 真正會開放的那個洞已經在 lib/nav.ts 補掉了（載入中改成一項都不給）。
 * 但補完之後會留下另一個症狀:**每次進站選單先空 300～600ms**。
 * 那個空白會讓人以為功能不見了 —— 也就是舊註解當初擔心的事。
 *
 * 所以把上一次查到的身分記在 sessionStorage，下次進站第一畫格就有選單，
 * 同時背景照樣去問一次資料庫，回來以真實值為準。
 *
 *
 * 【為什麼是 sessionStorage 不是 localStorage】
 *
 * sessionStorage 只活在**這個分頁**。分頁關掉就沒了。
 * localStorage 會跨分頁、跨天留著 —— 共用電腦上換人登入時，
 * 那一份會活得比它該活的久。
 *
 *
 * 【風險要講在前面】
 *
 * 快取只會是**同一個 user id 上一次查到的角色**。所以:
 *
 *   · 角色被降權（管家 → 房務）之後，第一次進站會先看到舊選單約 300ms，
 *     背景查回來就會收窄。這段時間他點得到「訂單」那一項 ——
 *     但點進去是空的，因為 RLS 沒有快取。
 *   · 換帳號:登出時會清掉（clearProfileCache），
 *     而且背景查回來時 id 對不上也會整份丟掉。
 *
 * **快取的是畫面，不是權限。** 資料一律以 RLS 為準。
 */
const CACHE_KEY = 'anxing.profile.v1';

function readCache(): Profile | null {
  if (typeof window === 'undefined') return null;   // SSR 沒有 sessionStorage
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    // 形狀對不上就當作沒有 —— 舊版本留下來的東西不要硬用
    return typeof p?.id === 'string' ? { id: p.id, name: p.name ?? null, role: p.role ?? null } : null;
  } catch { return null; }
}

function writeCache(p: Profile) {
  try { window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(p)); } catch { /* 無痕模式會丟 */ }
}

/** 登出時呼叫。不清的話，下一個人在同一個分頁登入會先看到上一個人的選單。 */
export function clearProfileCache() {
  try { window.sessionStorage.removeItem(CACHE_KEY); } catch { /* 同上 */ }
}

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  /*
   * ★ 初始值直接吃快取（useState 的函式形式 —— 只在第一次算）。
   *   放在 useEffect 裡設的話會晚一個畫格，那正好是要消掉的那一閃。
   */
  const [profile, setProfile] = useState<Profile | null>(() => readCache());
  // 有快取就不算「載入中」—— 選單直接畫出來，背景再對答案
  const [loading, setLoading] = useState(() => readCache() === null);

  useEffect(() => {
    let alive = true;
    (async () => {
      /*
       * ★ getSession 而不是 getUser。
       *
       *   getUser() 每次都往伺服器打一趟去驗證 token（實測 200～300ms）；
       *   getSession() 讀本機那份，同一個 tick 就回來。
       *
       *   這裡只需要 user.id 去查 profiles，而**那個查詢本身有 RLS**——
       *   偽造的本機 session 查回來是空的，換不到角色。
       *   真正驗證身分的是 middleware 與每一條 policy，不是這一行。
       */
      const { data: { session } } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) { if (alive) { clearProfileCache(); setProfile(null); setLoading(false); } return; }

      /*
       * ★★ 重試兩次（2026-08-22 使用者回報「重新 load 網頁就會重新讀權限，很不穩」）。
       *
       *   這一查在手機的 4G 上會逾時、在剛喚醒的分頁上會被 token 更新卡住。
       *   失敗一次的後果不是「慢一點」，是**整份選單消失**
       *   —— 因為 role 變成 null，而 nav 現在是預設拒絕。
       *
       *   問一次就放棄，等於把網路的抖動變成權限的抖動。
       */
      type Row = { name: string | null; role: string | null };
      let data: Row | null = null;
      let err: unknown = null;
      for (let i = 0; i < 3; i++) {
        const r = await supabase.from('profiles')
          .select('name, role').eq('id', user.id).maybeSingle();
        if (!alive) return;
        if (!r.error) { data = (r.data ?? null) as Row | null; err = null; break; }
        err = r.error;
        // 200ms → 400ms。再久使用者會以為當掉了
        await new Promise((res) => setTimeout(res, 200 * (i + 1)));
      }
      if (!alive) return;

      /*
       * ★★ 三次都失敗:**保留快取那份，不要覆蓋成 null**。
       *
       *   覆蓋成 null 的話畫面會突然說「你沒有角色」，選單全空 ——
       *   而原因只是網路不好。那正是「很不穩」的體感來源。
       *
       *   保留舊值的代價:剛被降權的人在網路壞掉時會多看到舊選單。
       *   他點得到,但點進去是空的 —— RLS 沒有快取,資料一定是對的。
       */
      if (err) {
        console.warn('[profile] 讀取角色失敗,沿用上一次的結果', err);
        setLoading(false);
        return;
      }

      const fresh: Profile = { id: user.id, name: data?.name ?? null, role: data?.role ?? null };
      setProfile(fresh);
      writeCache(fresh);
      setLoading(false);
    })();
    // 元件先卸載、查詢才回來的話別再 setState —— React 會警告，
    // 而且那個警告會被當成 bug 追半天
    return () => { alive = false; };
  }, [supabase]);

  /*
   * ★ 登出／換帳號時把快取丟掉。
   *   只靠 layout 的 logout() 不夠 —— token 過期、其他分頁登出
   *   都會走到這裡，而那些路徑上沒有人會記得清快取。
   */
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { clearProfileCache(); setProfile(null); setLoading(false); }
    });
    return () => { sub.subscription.unsubscribe(); };
  }, [supabase]);

  const value = useMemo(
    () => ({ profile, role: profile?.role ?? null, loading }),
    [profile, loading]);

  return <ProfileCtx.Provider value={value}>{children}</ProfileCtx.Provider>;
}

export function useProfile(): Ctx {
  return useContext(ProfileCtx);
}
