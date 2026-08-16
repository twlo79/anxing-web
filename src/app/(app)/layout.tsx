'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { ProfileProvider, useProfile } from '@/lib/profile';


const ROLE_LABEL: Record<string, string> = {
  housekeeper: '一般', accountant: '會計', manager: '主管', super_admin: '總經理',
};

/*
 * 側邊選單。**順序就是使用頻率**,不是功能分類 ——
 * 每天要用的排前面,設定類的沉底。改順序前先想「誰一天會點幾次」。
 *
 * 名稱刻意短。原本叫「短租訂單與收款」「契約訂單與收款」,
 * 兩個十個字的項目擺在一起,實際要分辨的只有前兩個字。
 */
/*
 * 【圖示回到 emoji】（使用者決定）
 *
 * 線條圖示的問題是十四個灰色線框在小尺寸下彼此太像 —— 帳簿、收據、契約
 * 都是「有線的方框」，得盯著看才分得出來。emoji 的輪廓與顏色天生就有差異，
 * 那正是「一眼認出」需要的東西。
 *
 * 代價是各系統長得不一樣（Windows / iOS / Android 各一套），
 * 而且 emoji 永遠是彩色的、不會跟著選取狀態變 ——
 * 所以下面的選取樣式改成淺色底，emoji 在上面還讀得到。
 *
 * 未選取時用 CSS 把彩度壓到 55%：整排看起來收斂，
 * 選到的那一項恢復滿彩度 —— 對比就從那裡來，不需要再加別的顏色。
 */
const NAV: { href: string; label: string; icon: string; roles: string[] }[] = [
  // 出勤排第一：全公司每天最少點兩次,而且是「上班第一件事」。
  // 它原本排在清潔記錄後面 —— 每天要用的東西不該讓人往下找。
  { href: '/attendance', label: '出勤', icon: '🕐', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  /*
   * 房務管理緊接在出勤後面（2026-08-14 使用者指定）。
   *
   * 這兩個是「人在現場」的兩件事:出勤講員工幾點上下班,
   * 房務講今天哪間房要清、誰去清。中間隔著訂單、營收、請款那一整段錢的東西,
   * 每天要看排班的人得從頭滑到中間。
   *
   * 全員都進得來 —— 但一般員工只看得到「行事曆」分頁（頁面內再分流）。
   * 排班是要互相配合的資訊。資料庫對應 migration_110 的唯讀政策,
   * 寫入仍然只有主管以上。
   */
  { href: '/housekeeping', label: '房務管理', icon: '🧺', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/shortterm', label: '訂單 | 收入', icon: '🛏️', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/contracts', label: '契約 | 收入', icon: '📋', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/revenues', label: '營收表', icon: '💰', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/purchases', label: '請款單控管', icon: '🧾', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/deposits', label: '押金管理', icon: '🔐', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/expenses', label: '支出明細', icon: '📒', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/dashboard', label: '財務儀錶板', icon: '📊', roles: ['accountant', 'manager', 'super_admin'] },
  // 客戶管理跟房務、評價、清潔是同一組:都是「人在現場會用到的」。
  // 上面那半段是錢(訂單、契約、營收、請款、押金、支出、儀表板)。
  // 客戶資料原本散在訂單 guest_name 與契約 tenant_name 兩邊,
  // 要查一位房客的電話得先猜他是長租還是短租。
  { href: '/customers', label: '客戶管理', icon: '👤', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/reviews', label: '房源評價', icon: '⭐', roles: ['housekeeper', 'manager', 'super_admin'] },
  { href: '/cleaning', label: '清潔記錄', icon: '🧹', roles: ['housekeeper', 'manager', 'super_admin'] },
  // 設定 = 通知偏好 ＋ 刪除紀錄。兩個都是「偶爾才進來一次」的東西，
  // 各佔一格會把每天要用的功能往下推。全角色都看得到：
  // 通知是每個人自己的偏好；刪除紀錄藏起來的話，誤刪的人第一時間
  // 找不到救回來的地方 —— 而那正是最需要它的時候。
  { href: '/settings', label: '設定', icon: '🎛️', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  // 會計進得去，但只看得到「收付款帳號」與「常用帳號」兩個分頁
  // —— 改人員角色那一頁仍然只有總經理，見 admin 頁的 ACCOUNTANT_TABS
  { href: '/admin', label: '權限管理', icon: '⚙️', roles: ['accountant', 'super_admin'] },
];

/**
 * Provider 包在最外層，裡面那層才是真正的版面。
 *
 * 拆成兩個元件是因為 `useProfile()` 必須在 Provider **底下**才讀得到 ——
 * 同一個元件裡自己提供又自己讀，拿到的是預設值（loading: true），
 * 而那個錯誤不會報錯，只會讓側邊欄永遠顯示不出職稱。
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <ProfileProvider><AppShell>{children}</AppShell></ProfileProvider>;
}

function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // 身分與角色由 ProfileProvider 提供 —— 全站只查一次（lib/profile.tsx）
  const { profile } = useProfile();
  const [navOpen, setNavOpen] = useState(false);
  /*
   * ============================================================
   * 【桌機側邊欄：預設收起，滑過去暫時展開，按住才固定】
   *
   * 三個狀態、兩個變數：
   *   pinned  = false  收起（預設）—— 只剩圖示，內容區多 96px
   *   hover            滑鼠移上去暫時展開，移開就收回去
   *   pinned  = true   按了 ‹ 之後固定展開，滑鼠移開也不收
   *
   * 【為什麼滑過去要展開】
   * 收起來只剩十四個 emoji，而 emoji 沒有共同的視覺語言 ——
   * 🧺 房務、🧹 清潔、📒 支出、🧾 請款，光看圖示分不出來。
   * 純收起等於逼人背圖示；滑過去就看得到名稱，那個成本就消失了。
   *
   * 【為什麼暫時展開要用蓋的，不能把內容推開】
   * 推開的話，滑鼠只是路過側邊欄，整頁的文字就往右跳一格。
   * 那種「我沒做什麼但畫面動了」是最讓人不安的互動。
   * 所以 hover 展開時側邊欄浮在內容上面，底下的版面一動也不動。
   *
   * 【為什麼 pinned 要記住】
   * 不記的話每次重整都彈回收起。使用者會按第二次、第三次，
   * 然後不再按 —— 一個每次都要重設的偏好等於沒有這個偏好。
   */
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  /*
   * 【按了收合卻沒收起來】（2026-08-14 回報）
   *
   * expanded = pinned || hover。按 ‹ 的時候滑鼠正好在側邊欄上面 ——
   * pinned 變成 false，但 hover 還是 true，所以**畫面一動也沒動**。
   *
   * 使用者只知道「按了沒反應」，然後會再按一次（變回 pinned），
   * 再按一次（又沒反應）—— 一顆按起來像壞掉的按鈕。
   *
   * 收起來的當下先把 hover 展開鎖住，滑鼠真的移開才解鎖。
   * 之後滑過去照樣展開，那個行為沒有變。
   */
  /*
   * 未讀通知數（migration_128）。
   *
   * 【為什麼要標在側邊欄上】
   * 推播是「錯過就沒了」—— 手機鎖屏滑掉之後,那則訊息在 app 裡
   * 沒有任何痕跡。打開 app 看不出有東西等著,等於存了也沒用。
   *
   * 數字掛在「設定」旁邊,因為新訊息就在那一頁底下。
   * 收起來的側邊欄只剩 emoji,所以那時改成一個小圓點 ——
   * 位置有限的時候「有沒有」比「幾則」重要。
   */
  const [unread, setUnread] = useState(0);
  const [hoverLock, setHoverLock] = useState(false);
  const expanded = pinned || (hover && !hoverLock);

  // 掛載後才讀 —— 伺服器算不出 localStorage,直接用會 hydration 不一致
  useEffect(() => {
    try { setPinned(localStorage.getItem('navPinned') === '1'); } catch {}
  }, []);
  function togglePinned() {
    setPinned((v) => {
      const next = !v;
      try { localStorage.setItem('navPinned', next ? '1' : '0'); } catch {}
      // 收起來時滑鼠一定還在側邊欄上（不然按不到那顆鈕）——
      // 不鎖的話 hover 會立刻把它撐回去，看起來就是「按了沒反應」
      if (!next) setHoverLock(true);
      return next;
    });
  }

  /*
   * 未讀數。切換頁面時重算 —— 使用者在新訊息頁標了已讀之後,
   * 數字要跟著掉,不然那顆紅點會一直在,然後它就失去意義了。
   *
   * 只算七天內的,跟新訊息頁顯示的範圍一致。
   * 兩邊不一致的話會出現「說有 3 則未讀,點進去只看到 1 則」。
   */
  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString();
      const { count } = await supabase.from('notifications')
        .select('id', { count: 'exact', head: true })
        .is('read_at', null).gte('created_at', since);
      setUnread(count ?? 0);
    })();
  }, [pathname]);

  // 換頁後把抽屜關掉,否則點完連結選單還蓋在畫面上
  useEffect(() => { setNavOpen(false); }, [pathname]);

  async function logout() {
    await createClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  // role 可能是 null（還在查，或這個帳號沒設角色）。
  // 那時先顯示全部選單項 —— 少顯示會讓人以為功能不見了，
  // 而點進去照樣被 RLS 擋，不會看到不該看的資料。
  const items = NAV.filter((n) => !profile?.role || n.roles.includes(profile.role));
  const current = items.find((n) => pathname.startsWith(n.href));

  /*
   * 選單。
   *
   * 【選取狀態是圓角膠囊，不是整條滿版】
   * 滿版的色塊會一路撞到側邊欄的右框線,看起來像被切掉一半。
   * 左右各留 8px、圓角 10px,色塊自己是一個完整的形狀。
   *
   * 【選取狀態用淺底 ＋ 左側細棒，不是深色滿版】
   * emoji 永遠是彩色的,深藍底會把它吃掉 —— 那正是最早改用線條圖示的原因。
   * 改成 12% 的主色淺底之後 emoji 讀得到,而淺底跟 hover 的白底很像,
   * 所以左邊再加一條 3px 的主色細棒當「硬」記號。
   */
  const navList = (mini = false) => (
    <nav className="flex-1 py-2 overflow-y-auto">
      {items.map((n) => {
        const on = pathname.startsWith(n.href);
        if (mini) {
          return (
            // title 是收起來時唯一的文字線索 —— 沒有它,分不出 🧺 跟 🧹
            <Link key={n.href} href={n.href} title={n.label} aria-label={n.label}
              className={`relative mx-2 my-0.5 flex items-center justify-center h-10
                rounded-[10px] transition-colors ${
                on ? 'bg-mor-slate/[0.12]' : 'hover:bg-white/75'}`}>
              {on && (
                <span aria-hidden
                  className="absolute left-0.5 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-full bg-mor-slate" />
              )}
              <span className="text-[19px] leading-none"
                style={{ filter: on ? 'none' : 'saturate(0.55)' }}>{n.icon}</span>
              {/* 收起來只有 56px —— 塞不下數字,而「有沒有」本來就比「幾則」重要 */}
              {n.href === '/settings' && unread > 0 && (
                <span aria-label={`${unread} 則未讀`}
                  className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500" />
              )}
            </Link>
          );
        }
        return (
          // 15px 而不是 14px。側邊欄是整天盯著的東西,而且中文在小字級下
          // 筆畫會糊在一起 —— 拉丁字母在 14px 還很清楚,中文不是。
          <Link key={n.href} href={n.href}
            className={`group relative mx-2 flex items-center gap-2.5 pl-3.5 pr-3 py-2
              rounded-[10px] text-[15px] transition-colors ${
              on ? 'bg-mor-slate/[0.12] text-mor-slate font-semibold'
                 : 'text-gray-700 font-medium hover:bg-white/75'
            }`}>
            {/* 左側一條主色細棒 —— 淺色底的選取狀態需要一個「硬」的記號,
                不然跟 hover 的淡底分不出來 */}
            {on && (
              <span aria-hidden
                className="absolute left-1 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-full bg-mor-slate" />
            )}
            {/* 未選取壓彩度到 55%,選到的恢復滿彩 —— 對比從這裡來,
                不需要再替十四個項目各配一個顏色 */}
            <span className="text-[17px] leading-none w-6 text-center shrink-0 transition-[filter]"
              style={{ filter: on ? 'none' : 'saturate(0.55)' }}>
              {n.icon}
            </span>
            {n.label}
            {n.href === '/settings' && unread > 0 && (
              <span className="ml-auto rounded-full bg-red-500 text-white text-[11px] font-semibold
                               min-w-[18px] h-[18px] px-1 flex items-center justify-center tabular-nums">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="app-bg min-h-screen md:flex">
      {/* 手機頂列:桌機隱藏 */}
      <header className="md:hidden sticky top-0 z-30 flex items-center gap-3 bg-white/75 backdrop-blur-xl border-b border-white/60 px-4 py-3"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <button onClick={() => setNavOpen(true)} aria-label="開啟選單"
          className="w-10 h-10 -ml-2 flex items-center justify-center rounded-lg text-gray-600 active:bg-gray-100">
          {/* 漢堡也畫成 SVG —— ☰ 是文字符號，粗細與行高在各家字型下都不一樣 */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
            strokeLinecap="round" className="w-6 h-6">
            <path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" />
          </svg>
        </button>
        <div className="min-w-0">
          <div className="font-bold leading-tight truncate">{current?.label ?? '安幸上工'}</div>
          {profile && <div className="text-[11px] text-gray-500 truncate">{profile.name}・{(profile.role && ROLE_LABEL[profile.role]) ?? profile.role ?? ''}</div>}
        </div>
      </header>

      {/* 手機抽屜 */}
      {navOpen && (
        <div className="md:hidden fixed inset-0 z-50" onClick={() => setNavOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <aside onClick={(e) => e.stopPropagation()}
            className="absolute left-0 top-0 h-full w-64 bg-white/90 backdrop-blur-xl flex flex-col shadow-xl">
            <div className="px-5 py-5 border-b border-mor-line/70" style={{ paddingTop: 'max(1.25rem, env(safe-area-inset-top))' }}>
              <div className="font-bold text-lg">安幸上工</div>
              {profile && (
                <div className="mt-1 text-xs text-gray-500">
                  {profile.name}・{(profile.role && ROLE_LABEL[profile.role]) ?? profile.role ?? ''}
                </div>
              )}
            </div>
            {navList()}
            <button onClick={logout} className="m-3 rounded-[10px] border border-mor-line py-2.5 text-sm text-gray-500 active:bg-mor-sand/70">
              登出
            </button>
          </aside>
        </div>
      )}

      {/*
        桌機側邊欄。
        外面這層只負責「佔位」—— 真正的側邊欄是 fixed 的，
        hover 展開時才不會把內容推開。
      */}
      <div className={`hidden md:block shrink-0 transition-[width] duration-200
                       ${pinned ? 'w-52' : 'w-14'}`} />
      <aside
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => { setHover(false); setHoverLock(false); }}
        className={`hidden md:flex fixed inset-y-0 left-0 z-40 flex-col
                    bg-white/95 backdrop-blur-xl border-r border-mor-line
                    transition-[width] duration-200
                    ${expanded ? 'w-52' : 'w-14'}
                    ${!pinned && hover ? 'shadow-2xl shadow-black/10' : ''}`}>

        {/* 標題列 ＋ 收合鈕。鈕放這裡而不是最下面 —— 那是視線第一個
            到的地方，也是「這條東西可以動」最直覺的位置 */}
        <div className={`h-[73px] shrink-0 border-b border-mor-line/70 flex items-center
                         ${expanded ? 'px-5 gap-2' : 'justify-center'}`}>
          {expanded ? (
            <>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-lg leading-tight truncate">安幸上工</div>
                {profile && (
                  <div className="text-xs text-gray-500 truncate">
                    {profile.name}・{(profile.role && ROLE_LABEL[profile.role]) ?? profile.role ?? ''}
                  </div>
                )}
              </div>
              <button onClick={togglePinned}
                title={pinned ? '取消固定（改成滑過才展開）' : '固定展開'}
                aria-label={pinned ? '取消固定' : '固定展開'}
                aria-pressed={pinned}
                className={`shrink-0 w-7 h-7 -mr-1.5 flex items-center justify-center rounded-lg
                            transition-colors ${pinned
                              ? 'text-mor-slate bg-mor-slate/[0.12]'
                              : 'text-gray-400 hover:text-gray-600 hover:bg-mor-sand/70'}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
            </>
          ) : (
            // 收起來時只剩一個字。名字與職稱在 56px 下一定會被截斷，
            // 而截斷的名字比沒有名字更難讀
            <span className="font-bold text-lg" title="安幸上工">安</span>
          )}
        </div>

        {navList(!expanded)}

        <button onClick={logout} title="登出"
          className={`m-2 rounded-[10px] border border-mor-line py-2 text-sm text-gray-500
                      hover:bg-mor-sand/70 hover:text-gray-700 transition-colors`}>
          {expanded ? '登出' : '⏻'}
        </button>
      </aside>

      <main className="flex-1 min-w-0 p-4 md:p-6"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
        {children}
      </main>
    </div>
  );
}
