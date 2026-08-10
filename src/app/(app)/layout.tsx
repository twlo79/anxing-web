'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import NavIcon, { TINT, type IconName } from '@/components/NavIcon';

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
const NAV: { href: string; label: string; icon: IconName; roles: string[] }[] = [
  // 出勤排第一：全公司每天最少點兩次,而且是「上班第一件事」。
  // 它原本排在清潔記錄後面 —— 每天要用的東西不該讓人往下找。
  { href: '/attendance', label: '出勤', icon: 'clock', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/shortterm', label: '訂單 | 收入', icon: 'bed', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/contracts', label: '契約 | 收入', icon: 'contract', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/revenues', label: '營收表', icon: 'coins', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/purchases', label: '請款單控管', icon: 'receipt', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/deposits', label: '押金管理', icon: 'lock', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/expenses', label: '支出明細', icon: 'book', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/dashboard', label: '財務儀錶板', icon: 'chart', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/housekeeping', label: '房務管理', icon: 'broom', roles: ['manager', 'super_admin'] },
  // 客戶管理跟房務、評價、清潔是同一組:都是「人在現場會用到的」。
  // 上面那半段是錢(訂單、契約、營收、請款、押金、支出、儀表板)。
  // 客戶資料原本散在訂單 guest_name 與契約 tenant_name 兩邊,
  // 要查一位房客的電話得先猜他是長租還是短租。
  { href: '/customers', label: '客戶管理', icon: 'user', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/reviews', label: '房源評價', icon: 'star', roles: ['housekeeper', 'manager', 'super_admin'] },
  { href: '/cleaning', label: '清潔記錄', icon: 'sparkle', roles: ['housekeeper', 'manager', 'super_admin'] },
  // 通知是每個人自己的偏好,所以全角色都看得到 ——
  // 放在權限管理上面（那頁只有總經理進得去,擺一起會讓人以為這也是管理員專用）
  { href: '/notifications', label: '通知設定', icon: 'bell', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  // 會計進得去，但只看得到「收付款帳號」與「常用帳號」兩個分頁
  // —— 改人員角色那一頁仍然只有總經理，見 admin 頁的 ACCOUNTANT_TABS
  { href: '/admin', label: '權限管理', icon: 'settings', roles: ['accountant', 'super_admin'] },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [profile, setProfile] = useState<{ name: string; role: string } | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase.from('profiles').select('name, role').eq('id', user.id).single();
      if (data) setProfile(data);
    });
  }, []);

  // 換頁後把抽屜關掉,否則點完連結選單還蓋在畫面上
  useEffect(() => { setNavOpen(false); }, [pathname]);

  async function logout() {
    await createClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  const items = NAV.filter((n) => !profile || n.roles.includes(profile.role));
  const current = items.find((n) => pathname.startsWith(n.href));

  /*
   * 選單。
   *
   * 【選取狀態是圓角膠囊，不是整條滿版】
   * 滿版的色塊會一路撞到側邊欄的右框線,看起來像被切掉一半。
   * 左右各留 8px、圓角 10px,色塊自己是一個完整的形狀。
   *
   * 【圖示有顏色，文字沒有】
   * 三個顏色（見 NavIcon 的 TINT）：綠 = 錢進來、橘 = 錢出去、藍 = 其他。
   * 文字全部維持深灰 —— 十四行彩色的字讀起來很吵,而真正要讀的是字,
   * 顏色只是幫你快速找到「那一組在哪裡」。
   *
   * 【為什麼用 inline style 而不是 Tailwind 的顏色類別】
   * Tailwind 是靜態掃檔案產生 CSS 的,`bg-[${tint}]` 這種動態拼出來的類別
   * **不會被產生** —— 開發時看起來正常（因為別的地方剛好用過那個色），
   * 上線後就變透明。顏色來自資料時一律用 inline style。
   */
  const navList = (
    <nav className="flex-1 py-2 overflow-y-auto">
      {items.map((n) => {
        const on = pathname.startsWith(n.href);
        const tint = TINT[n.icon];
        return (
          // 15px 而不是 14px。側邊欄是整天盯著的東西,而且中文在小字級下
          // 筆畫會糊在一起 —— 拉丁字母在 14px 還很清楚,中文不是。
          <Link key={n.href} href={n.href}
            className={`group mx-2 flex items-center gap-3 px-3 py-2.5 md:py-2 rounded-[10px]
              text-[15px] font-medium transition-colors ${
              on ? 'bg-gradient-to-r from-mor-slate to-mor-slatedark text-white shadow-[0_4px_12px_-4px_rgba(65,104,155,0.6)]'
                 : 'text-gray-700 hover:bg-white/70'
            }`}>
            {/* 只給線條上色，不加底色方塊 —— 三個顏色已經夠分辨，
                再加十四個色塊會把「簡約」做成「花俏」 */}
            <NavIcon name={n.icon} style={{ color: on ? '#fff' : tint }} />
            {n.label}
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
          {profile && <div className="text-[11px] text-gray-500 truncate">{profile.name}・{ROLE_LABEL[profile.role] ?? profile.role}</div>}
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
                  {profile.name}・{ROLE_LABEL[profile.role] ?? profile.role}
                </div>
              )}
            </div>
            {navList}
            <button onClick={logout} className="m-3 rounded-[10px] border border-mor-line py-2.5 text-sm text-gray-500 active:bg-mor-sand/70">
              登出
            </button>
          </aside>
        </div>
      )}

      {/* 桌機側邊欄 */}
      <aside className="hidden md:flex w-52 shrink-0 flex-col bg-white/70 backdrop-blur-xl border-r border-white/60">
        <div className="px-5 py-5 border-b border-mor-line/70">
          <div className="font-bold text-lg">安幸上工</div>
          {profile && (
            <div className="mt-1 text-xs text-gray-500">
              {profile.name}・{ROLE_LABEL[profile.role] ?? profile.role}
            </div>
          )}
        </div>
        {navList}
        <button onClick={logout} className="m-3 rounded-[10px] border border-mor-line py-2 text-sm text-gray-500 hover:bg-mor-sand/70 hover:text-gray-700 transition-colors">
          登出
        </button>
      </aside>

      <main className="flex-1 min-w-0 p-4 md:p-6"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
        {children}
      </main>
    </div>
  );
}
