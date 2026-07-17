'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';

const ROLE_LABEL: Record<string, string> = {
  housekeeper: '管家', manager: '主管', super_admin: 'Super Admin',
};

const NAV = [
  { href: '/revenues', label: '營收', icon: '💰', roles: ['manager', 'super_admin'] },
  { href: '/expenses', label: '支出', icon: '📒', roles: ['manager', 'super_admin'] },
  { href: '/reviews', label: '評價', icon: '⭐', roles: ['housekeeper', 'manager', 'super_admin'] },
  { href: '/cleaning', label: '清潔記錄', icon: '🧹', roles: ['housekeeper', 'manager', 'super_admin'] },
  { href: '/contracts', label: '契約訂單與收款', icon: '📋', roles: ['housekeeper', 'manager', 'super_admin'] },
  { href: '/admin', label: '設定', icon: '⚙️', roles: ['super_admin'] },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [profile, setProfile] = useState<{ name: string; role: string } | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase.from('profiles').select('name, role').eq('id', user.id).single();
      if (data) setProfile(data);
    });
  }, []);

  async function logout() {
    await createClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  const items = NAV.filter((n) => !profile || n.roles.includes(profile.role));

  return (
    <div className="min-h-screen flex">
      <aside className="w-52 shrink-0 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-5 py-5 border-b border-gray-100">
          <div className="font-bold text-lg">安幸上工</div>
          {profile && (
            <div className="mt-1 text-xs text-gray-500">
              {profile.name}・{ROLE_LABEL[profile.role] ?? profile.role}
            </div>
          )}
        </div>
        <nav className="flex-1 py-3">
          {items.map((n) => (
            <Link key={n.href} href={n.href}
              className={`flex items-center gap-3 px-5 py-2.5 text-sm font-medium ${
                pathname.startsWith(n.href) ? 'bg-mor-slate text-white' : 'text-gray-700 hover:bg-gray-100'
              }`}>
              <span>{n.icon}</span>{n.label}
            </Link>
          ))}
        </nav>
        <button onClick={logout} className="m-4 rounded-lg border border-gray-300 py-2 text-sm text-gray-600 hover:bg-gray-100">
          登出
        </button>
      </aside>
      <main className="flex-1 min-w-0 p-6">{children}</main>
    </div>
  );
}
