'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';

type Staff = { id: string; name: string; aliases: string[]; staff_type: string; active: boolean; sort: number };
type Estate = { id: string; name: string; manager: string | null; sort: number };

const TYPE_LABEL: Record<string, string> = { housekeeper: '管家', roomservice: '房務', other: '其他/離職' };

export default function AdminPage() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [role, setRole] = useState<string | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const { data: st } = await supabase.from('staff').select('*').order('sort').order('name');
    const { data: es } = await supabase.from('estates').select('*').order('sort').order('name');
    setStaff(st ?? []);
    setEstates(es ?? []);
  }, [supabase]);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/login'); return; }
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setRole(data?.role ?? null);
      if (data?.role !== 'super_admin') return;
      load();
    });
  }, [supabase, router, load]);

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 2500); }

  // ---- 人員 ----
  const activeHousekeepers = useMemo(() => staff.filter((s) => s.active && s.staff_type === 'housekeeper'), [staff]);
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffType, setNewStaffType] = useState('housekeeper');

  async function addStaff() {
    const name = newStaffName.trim();
    if (!name) return;
    const { error } = await supabase.from('staff').insert({ name, staff_type: newStaffType, active: true, sort: 50 });
    if (error) return flash('新增失敗:' + error.message);
    setNewStaffName(''); flash('已新增 ' + name); load();
  }
  async function updateStaff(id: string, patch: Partial<Staff>) {
    const { error } = await supabase.from('staff').update(patch).eq('id', id);
    if (error) return flash('更新失敗:' + error.message);
    flash('已更新'); load();
  }

  // ---- 物業 ----
  const [newEstateName, setNewEstateName] = useState('');
  async function addEstate() {
    const name = newEstateName.trim();
    if (!name) return;
    const { error } = await supabase.from('estates').insert({ name, sort: 50 });
    if (error) return flash('新增失敗:' + error.message);
    setNewEstateName(''); flash('已新增 ' + name); load();
  }
  async function updateEstate(id: string, patch: Partial<Estate>) {
    const { error } = await supabase.from('estates').update(patch).eq('id', id);
    if (error) return flash('更新失敗:' + error.message);
    flash('已更新'); load();
  }
  async function deleteEstate(id: string, name: string) {
    if (!confirm(`確定刪除物業「${name}」?此物業下的房源會失去物業歸屬(評價/清潔紀錄仍保留)。`)) return;
    const { error } = await supabase.from('estates').delete().eq('id', id);
    if (error) return flash('刪除失敗(可能仍有房源綁定):' + error.message);
    flash('已刪除'); load();
  }

  if (role === null) return <div className="text-gray-400 py-20 text-center">載入中…</div>;
  if (role !== 'super_admin') return <div className="text-gray-400 py-20 text-center">此頁僅限 Super Admin</div>;

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold">設定</h1>
        {msg && <span className="text-sm text-mor-green font-medium">{msg}</span>}
      </div>

      {/* ===== 人員管理 ===== */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">人員管理</h2>
        <div className="bg-white rounded-xl border border-mor-line overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-mor-sand/40">
                <th className="px-4 py-2.5">姓名</th>
                <th className="px-4 py-2.5">職位</th>
                <th className="px-4 py-2.5">狀態</th>
                <th className="px-4 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id} className="border-b border-mor-line/60 last:border-0">
                  <td className="px-4 py-2 font-medium">{s.name}{s.aliases?.length ? <span className="ml-1 text-xs text-gray-400">({s.aliases.join('/')})</span> : null}</td>
                  <td className="px-4 py-2">
                    <select value={s.staff_type} onChange={(e) => updateStaff(s.id, { staff_type: e.target.value })}
                      className="rounded-lg border border-gray-300 px-2 py-1 text-sm">
                      <option value="housekeeper">管家</option>
                      <option value="roomservice">房務</option>
                      <option value="other">其他/離職</option>
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${s.active ? 'bg-mor-greenlight text-mor-green' : 'bg-gray-100 text-gray-400'}`}>
                      {s.active ? '在職' : '停用'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => updateStaff(s.id, { active: !s.active })}
                      className="text-xs text-mor-slate underline hover:text-mor-blue">
                      {s.active ? '設為停用/離職' : '恢復在職'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center gap-2 px-4 py-3 border-t border-mor-line bg-mor-sand/20 text-sm">
            <input value={newStaffName} onChange={(e) => setNewStaffName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addStaff(); }}
              placeholder="新人員姓名" className="rounded-lg border border-gray-300 px-2 py-1.5 w-40" />
            <select value={newStaffType} onChange={(e) => setNewStaffType(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
              <option value="housekeeper">管家</option>
              <option value="roomservice">房務</option>
            </select>
            <button onClick={addStaff} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增人員</button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-2">停用=離職:紀錄保留、可查詢,但從統計列表排除;總數仍計入營運總量。</p>
      </section>

      {/* ===== 物業與負責人 ===== */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">物業與負責人</h2>
        <div className="bg-white rounded-xl border border-mor-line overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-mor-sand/40">
                <th className="px-4 py-2.5">物業</th>
                <th className="px-4 py-2.5">負責管家</th>
                <th className="px-4 py-2.5 w-20">排序</th>
                <th className="px-4 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {estates.map((e) => (
                <tr key={e.id} className="border-b border-mor-line/60 last:border-0">
                  <td className="px-4 py-2 font-medium">{e.name}</td>
                  <td className="px-4 py-2">
                    <select value={e.manager ?? ''} onChange={(ev) => updateEstate(e.id, { manager: ev.target.value || null })}
                      className="rounded-lg border border-gray-300 px-2 py-1 text-sm min-w-24">
                      <option value="">未指派</option>
                      {activeHousekeepers.map((h) => <option key={h.id} value={h.name}>{h.name}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <input type="number" defaultValue={e.sort} onBlur={(ev) => { const v = parseInt(ev.target.value); if (v !== e.sort) updateEstate(e.id, { sort: v }); }}
                      className="rounded-lg border border-gray-300 px-2 py-1 w-16 text-sm" />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => deleteEstate(e.id, e.name)} className="text-xs text-red-500 underline hover:text-red-700">刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center gap-2 px-4 py-3 border-t border-mor-line bg-mor-sand/20 text-sm">
            <input value={newEstateName} onChange={(e) => setNewEstateName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addEstate(); }}
              placeholder="新物業名稱" className="rounded-lg border border-gray-300 px-2 py-1.5 w-40" />
            <button onClick={addEstate} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增物業</button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-2">負責管家影響「評價」頁的管家評分:換人後該物業所有評價(含過去)歸現任負責人。排序數字越小越前面。</p>
      </section>
    </div>
  );
}
