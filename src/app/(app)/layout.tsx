'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';

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
const NAV = [
  { href: '/shortterm', label: '訂單 | 收入', icon: '🏨', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/contracts', label: '契約 | 收入', icon: '📋', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/revenues', label: '營收表', icon: '💰', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/purchases', label: '請款單控管', icon: '🧾', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/deposits', label: '押金管理', icon: '🔐', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/expenses', label: '支出明細', icon: '📒', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/dashboard', label: '財務儀錶板', icon: '📊', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/housekeeping', label: '房務管理', icon: '🛏️', roles: ['manager', 'super_admin'] },
  { href: '/reviews', label: '房源評價', icon: '⭐', roles: ['housekeeper', 'manager', 'super_admin'] },
  { href: '/cleaning', label: '清潔記錄', icon: '🧹', roles: ['housekeeper', 'manager', 'super_admin'] },
  // 通知是每個人自己的偏好,所以全角色都看得到 ——
  // 放在權限管理上面（那頁只有總經理進得去,擺一起會讓人以為這也是管理員專用）
  { href: '/notifications', label: '通知設定', icon: '🔔', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  // 會計進得去，但只看得到「收付款帳號」與「常用帳號」兩個分頁
  // —— 改人員角色那一頁仍然只有總經理，見 admin 頁的 ACCOUNTANT_TABS
  { href: '/admin', label: '權限管理', icon: '⚙️', roles: ['accountant', 'super_admin'] },
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

  const navList = (
    <nav className="flex-1 py-3 overflow-y-auto">
      {items.map((n) => (
        // 15px 而不是 14px。側邊欄是整天盯著的東西,而且中文在小字級下
        // 筆畫會糊在一起 —— 拉丁字母在 14px 還很清楚,中文不是。
        <Link key={n.href} href={n.href}
          className={`flex items-center gap-3 px-5 py-3 md:py-2.5 text-[15px] font-medium ${
            pathname.startsWith(n.href) ? 'bg-mor-slate text-white' : 'text-gray-700 hover:bg-gray-100'
          }`}>
          <span className="text-base leading-none">{n.icon}</span>{n.label}
        </Link>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen md:flex">
      {/* 手機頂列:桌機隱藏 */}
      <header className="md:hidden sticky top-0 z-30 flex items-center gap-3 bg-white border-b border-gray-200 px-4 py-3"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <button onClick={() => setNavOpen(true)} aria-label="開啟選單"
          className="w-10 h-10 -ml-2 flex items-center justify-center rounded-lg text-xl text-gray-600 active:bg-gray-100">
          ☰
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
            className="absolute left-0 top-0 h-full w-64 bg-white flex flex-col shadow-xl">
            <div className="px-5 py-5 border-b border-gray-100" style={{ paddingTop: 'max(1.25rem, env(safe-area-inset-top))' }}>
              <div className="font-bold text-lg">安幸上工</div>
              {profile && (
                <div className="mt-1 text-xs text-gray-500">
                  {profile.name}・{ROLE_LABEL[profile.role] ?? profile.role}
                </div>
              )}
            </div>
            {navList}
            <button onClick={logout} className="m-4 rounded-lg border border-gray-300 py-2.5 text-sm text-gray-600 active:bg-gray-100">
              登出
            </button>
          </aside>
        </div>
      )}

      {/* 桌機側邊欄 */}
      <aside className="hidden md:flex w-52 shrink-0 bg-white border-r border-gray-200 flex-col">
        <div className="px-5 py-5 border-b border-gray-100">
          <div className="font-bold text-lg">安幸上工</div>
          {profile && (
            <div className="mt-1 text-xs text-gray-500">
              {profile.name}・{ROLE_LABEL[profile.role] ?? profile.role}
            </div>
          )}
        </div>
        {navList}
        <button onClick={logout} className="m-4 rounded-lg border border-gray-300 py-2 text-sm text-gray-600 hover:bg-gray-100">
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
