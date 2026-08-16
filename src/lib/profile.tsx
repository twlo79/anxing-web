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

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { if (alive) setLoading(false); return; }
      const { data } = await supabase.from('profiles')
        .select('name, role').eq('id', user.id).single();
      if (!alive) return;
      setProfile({ id: user.id, name: data?.name ?? null, role: data?.role ?? null });
      setLoading(false);
    })();
    // 元件先卸載、查詢才回來的話別再 setState —— React 會警告，
    // 而且那個警告會被當成 bug 追半天
    return () => { alive = false; };
  }, [supabase]);

  const value = useMemo(
    () => ({ profile, role: profile?.role ?? null, loading }),
    [profile, loading]);

  return <ProfileCtx.Provider value={value}>{children}</ProfileCtx.Provider>;
}

export function useProfile(): Ctx {
  return useContext(ProfileCtx);
}
