'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { ProfileProvider, useProfile } from '@/lib/profile';


const ROLE_LABEL: Record<string, string> = {
  cleaner: '房務', housekeeper: '管家', accountant: '會計', manager: '主管', super_admin: '總經理',
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
/**
 * 【房務 `cleaner`】（2026-08-16 使用者指定）
 *
 * 選單只留四項:出勤、房務管理、清潔記錄、設定。
 *
 * 【這是收窄選單，不是權限隔離】（使用者選的做法）
 *
 * 資料庫的 RLS 沒有動 —— `cleaner` 在資料庫眼裡跟管家一樣。
 * 房務如果知道網址，直接打 `/shortterm` 還是進得去。
 *
 * 為什麼先這樣:真正的權限隔離要改一批 RLS policy，而漏掉一條的症狀是
 * 「他當天打不了卡」或「看不到自己的班表」—— 那兩個都不會報錯，
 * 只會是一片空白，而他不會知道要跟誰講。
 *
 * 房務是內部員工不是外人，先把每天用的東西整理乾淨、
 * 不要每次都從十四項裡找那三項，價值已經到手了。
 * 哪天真的需要隔離（例如要防止看到房客電話），再單獨處理。
 */
const NAV: { href: string; label: string; icon: string; roles: string[] }[] = [
  // 出勤排第一：全公司每天最少點兩次,而且是「上班第一件事」。
  // 它原本排在清潔記錄後面 —— 每天要用的東西不該讓人往下找。
  { href: '/attendance', label: '出勤', icon: '🕐', roles: ['cleaner', 'housekeeper', 'accountant', 'manager', 'super_admin'] },
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
  { href: '/housekeeping', label: '房務管理', icon: '🛎️', roles: ['cleaner', 'housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/shortterm', label: '訂單 | 收入', icon: '🛏️', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/contracts', label: '契約 | 收入', icon: '🤝', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/revenues', label: '營收表', icon: '💰', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/purchases', label: '請款單控管', icon: '🧾', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  /*
   * 管家看得到押金，但**只能檢視**（2026-08-17 使用者指定）——
   * 房客問「押金退了沒」時不用再去找會計。
   * 寫入由 RLS 擋（migration_139 只加 select policy），
   * 畫面上的新增／編輯／刪除／回收桶也一併藏掉。
   *
   * `cleaner` 不放進選單 —— 但 RLS 跟 housekeeper 相同（migration_131），
   * 知道網址還是進得去。那是既有的取捨,不是這次新增的。
   */
  { href: '/deposits', label: '押金管理', icon: '🏦', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/expenses', label: '支出明細', icon: '💳', roles: ['accountant', 'manager', 'super_admin'] },
  /*
   * 帳戶管理（migration_142）。三個銀行帳戶的流水鏡像。
   *
   * 只給會計以上 —— 銀行流水沒有「只看自己的」這回事，
   * 而 RLS 也是這樣寫的（bank_* 三張表都限這三個角色）。
   * 這一頁的選單與 RLS 一致，藏起來不是為了安全，是為了不騙人。
   *
   * 放在支出明細後面：它跟押金、支出是同一組「錢從哪裡進出」。
   *
   * 【icon 不能跟押金太像】（2026-08-19 使用者指出）
   * 原本是 🏛️,而押金是 🏦 —— 兩個都是「有柱子的建築物」,
   * 側邊欄收合成只剩 icon 時分不出來。
   * 改成 🏧:提款機,一眼就是「銀行流水」,跟其他頁都不撞。
   */
  { href: '/accounts', label: '帳戶明細', icon: '🏧', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/dashboard', label: '財務儀錶板', icon: '📊', roles: ['accountant', 'manager', 'super_admin'] },
  // 客戶管理跟房務、評價、清潔是同一組:都是「人在現場會用到的」。
  // 上面那半段是錢(訂單、契約、營收、請款、押金、支出、儀表板)。
  // 客戶資料原本散在訂單 guest_name 與契約 tenant_name 兩邊,
  // 要查一位房客的電話得先猜他是長租還是短租。
  { href: '/customers', label: '客戶管理', icon: '👥', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/reviews', label: '房源評價', icon: '⭐', roles: ['housekeeper', 'manager', 'super_admin'] },
  { href: '/cleaning', label: '清潔記錄', icon: '🧹', roles: ['cleaner', 'housekeeper', 'manager', 'super_admin'] },
  // 設定 = 通知偏好 ＋ 刪除紀錄。兩個都是「偶爾才進來一次」的東西，
  // 各佔一格會把每天要用的功能往下推。全角色都看得到：
  // 通知是每個人自己的偏好；刪除紀錄藏起來的話，誤刪的人第一時間
  // 找不到救回來的地方 —— 而那正是最需要它的時候。
  { href: '/settings', label: '設定', icon: '🔔', roles: ['cleaner', 'housekeeper', 'accountant', 'manager', 'super_admin'] },
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
   * 兩個狀態，一個變數：
   *   pinned = true   展開（預設）
   *   pinned = false  收起，只剩圖示，內容區多 152px
   *
   * 【滑過去不展開】（2026-08-16）
   * 原本收起時滑鼠移上去會浮出來 —— 而浮出來會蓋住底下的字。
   * 那個功能是為了「預設收起」設計的，現在預設展開，它就沒有存在的理由了。
   * 收起來的人是主動選的,滑過去又跳出來只會擋到他要看的東西。
   *
   * 收起時靠每一項的 `title` 認 —— 停一秒出現原生提示，不蓋住任何東西。
   *
   * 【為什麼 pinned 要記住】
   * 不記的話每次重整都彈回收起。使用者會按第二次、第三次，
   * 然後不再按 —— 一個每次都要重設的偏好等於沒有這個偏好。
   */
  /*
   * 【預設打開】（2026-08-16 使用者指定）
   *
   * 原本預設收起，滑過去才展開。收起來只剩十四個 emoji，
   * 而 emoji 沒有共同的視覺語言 —— 每次要點某一項都得先滑過去看名稱，
   * 那等於每天做幾十次多餘的動作。
   *
   * 現在預設展開，按 ‹ 才收起來，而且那個選擇會記住。
   *
   * 【收起來之後怎麼回來】（2026-08-16 修，症狀「左邊變打不開了」）
   *
   * 拿掉滑過展開的那一版，把收合鈕只留在展開狀態的標題列裡 ——
   * 收起來之後畫面上就**沒有任何東西可以把它打開**，而且那個狀態
   * 存進 localStorage，重整也回不來。單向的收合等於壞掉。
   *
   * 現在收起時的「安」自己就是展開鈕（滑過去變成 ›）。
   * 規則:**收起來的狀態必須自己帶著展開的方法。**
   */
  const [pinned, setPinned] = useState(true);
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
  /*
   * 【滑過去不再展開】（2026-08-16）
   *
   * 原本收起時滑鼠移上去會暫時展開，而且是**浮在內容上面**
   * （刻意不推開版面 —— 滑鼠只是路過就讓整頁文字往右跳很不安）。
   *
   * 但浮上去的代價是**蓋住底下的字**。實際用起來是:
   * 滑鼠不小心經過側邊欄，右邊那一段內容就讀不到了。
   *
   * 而且這個功能存在的理由已經消失 —— 它是為了「預設收起」設計的，
   * 現在預設是展開的。收起來是使用者主動選的，
   * 那他就是要一條窄的側邊欄，不該滑過去又跳出來蓋住東西。
   *
   * 收起時分不出哪個 emoji 是哪一頁？每一項都有 `title`，
   * 停住一秒會出現原生提示 —— 那個不會蓋住任何東西。
   */
  const expanded = pinned;

  // 掛載後才讀 —— 伺服器算不出 localStorage,直接用會 hydration 不一致
  useEffect(() => {
    /*
     * 沒存過就是打開（預設值）。
     *
     * 寫成 `=== '1'` 的話，第一次來的人會拿到收起來的側邊欄 ——
     * 那跟上面的 useState(true) 對不起來，畫面會先展開再收掉，閃一下。
     */
    try { setPinned(localStorage.getItem('navPinned') !== '0'); } catch {}
  }, []);
  function togglePinned() {
    setPinned((v) => {
      const next = !v;
      try { localStorage.setItem('navPinned', next ? '1' : '0'); } catch {}
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

        外面這層只負責「佔位」，真正的側邊欄是 fixed 的。
        兩層的寬度都跟著 pinned 走 —— **一定要一致**，
        不一致的話內容會被側邊欄蓋住一段，而那一段就是讀不到的字。
      */}
      <div className={`hidden md:block shrink-0 transition-[width] duration-200
                       ${pinned ? 'w-52' : 'w-14'}`} />
      <aside
        className={`hidden md:flex fixed inset-y-0 left-0 z-40 flex-col
                    bg-white/95 backdrop-blur-xl border-r border-mor-line
                    transition-[width] duration-200
                    ${expanded ? 'w-52' : 'w-14'}`}>

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
            /*
             * 收起來的時候「安」**本身就是展開鈕**。
             *
             * 【為什麼這裡一定要是按鈕】
             * 前一版這裡是純文字 `<span>安</span>`，而收合鈕只寫在上面
             * `expanded ?` 的那一支 —— 也就是**收起來之後畫面上沒有任何東西
             * 可以把它打開**。同一次改動又拿掉了滑過展開（那是為了修「側邊欄
             * 蓋住內容」），於是收合變成單向的:按一次就再也回不來。
             *
             * 這種錯不會報錯、tsc 不會抓、測試也測不到 ——
             * 它只在「使用者按下去之後」才存在。
             *
             * 規則:**任何可以收起來的東西，收起來的狀態必須自己帶著展開的方法。**
             * 不能靠另一個狀態下才出現的按鈕。
             */
            /*
             * 收起時標題列是「安幸」，滑過去換成 ›。
             *
             * 【為什麼這裡可以靠 hover，下面那顆不行】（2026-08-16 使用者指定）
             *
             * 這裡的 hover 是**錦上添花**，不是唯一的入口 ——
             * 選單底部有一顆常駐的 › 按鈕（見下面）。真正要保證的是
             * 「收起來的狀態必須自己帶著展開的方法」，那條由底部那顆負責。
             *
             * 既然入口已經有了，這裡就不需要再放一顆有底色的膠囊 ——
             * 兩個常駐的箭頭在 56px 寬的欄位裡是視覺噪音，
             * 而「安幸」本身要留著:那是整條欄位唯一的定位點。
             *
             * 【為什麼用透明度切換而不是換文字】
             * 兩個元素都在，只切 opacity —— 直接換內容的話寬度會跳一下，
             * 而那一跳會讓旁邊的圖示列跟著抖。
             */
            <button onClick={togglePinned} title="展開選單" aria-label="展開選單"
              aria-pressed={false}
              className="w-full h-full flex items-center justify-center relative
                         text-gray-700 hover:bg-mor-sand/60 transition-colors group">
              <span className="font-bold text-[15px] tracking-tight
                               group-hover:opacity-0 transition-opacity">安幸</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}
                strokeLinecap="round" strokeLinejoin="round"
                className="w-4 h-4 absolute text-mor-slate
                           opacity-0 group-hover:opacity-100 transition-opacity">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          )}
        </div>

        {navList(!expanded)}

        {/*
          收起時**下面再放一顆展開鈕**。
          只有最上面那一顆的話，人在點下半部的選單（設定、全線管理）時
          要把滑鼠拉回頂端才展開得了 —— 那是一段每次都要走的多餘距離。

          兩顆做同一件事不是重複，是**讓入口靠近手在的位置**。
          展開之後這一顆就消失，因為那時標題列的 ‹ 就在旁邊。
        */}
        {!expanded && (
          <button onClick={togglePinned} title="展開選單" aria-label="展開選單"
            className="mx-2 mb-1 h-8 rounded-[10px] flex items-center justify-center
                       bg-mor-slate/[0.10] text-mor-slate
                       hover:bg-mor-slate hover:text-white transition-colors">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}
              strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        )}

        <button onClick={logout} title="登出"
          className={`m-2 rounded-[10px] border border-mor-line py-2 text-sm text-gray-500
                      hover:bg-mor-sand/70 hover:text-gray-700 transition-colors`}>
          {expanded ? '登出' : '⏻'}
        </button>
      </aside>

      {/*
        【內容寬度統一在這裡，不在各頁】（2026-08-16 使用者指定）

        原本每一頁自己寫 max-w:儀表板 1400、設定與客戶 1100、出勤 980，
        營收與訂單完全沒寫（跟著螢幕拉滿）。結果是**換一頁邊界就跳一次** ——
        而那個跳動看起來像頁面沒對齊,實際上是五個不同的決定。

        統一在 <main> 上,各頁不再自己管。1280px 的理由:

          · 併成六欄之後營收表最寬的那一列約 1,100px,還有餘裕
          · 再寬下去每一列會拉成一條長線,眼睛從房源掃到金額要橫跨整個螢幕
          · 27 吋螢幕上兩側各留約 200px,看起來是刻意的留白而不是沒填滿

        `mx-auto` 讓它置中 —— 靠左的話在寬螢幕上右半邊會空一大片,
        而側邊欄在左邊,整個畫面會偏得很明顯。
      */}
      <main className="flex-1 min-w-0 p-4 md:p-6"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
        <div className="mx-auto w-full max-w-[1280px]">
          {children}
        </div>
      </main>
    </div>
  );
}
