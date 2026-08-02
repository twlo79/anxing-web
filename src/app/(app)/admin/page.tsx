'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';

type Staff = { id: string; name: string; aliases: string[]; staff_type: string; active: boolean; sort: number; role?: string; email?: string | null; auth_uid?: string | null };
type Estate = { id: string; name: string; manager: string | null; sort: number; active: boolean };
type Property = { id: string; name: string; estate_id: string | null };
type Profile = { id: string; name: string | null; role: string; active: boolean };
type PayAccount = {
  id: string; method: string; code: string; name: string;
  for_income: boolean; for_payment: boolean; sort: number; active: boolean;
};

const METHOD_LABEL: Record<string, string> = { transfer: '匯款', credit_card: '信用卡' };

const TYPE_LABEL: Record<string, string> = { housekeeper: '管家', roomservice: '房務', manager: '經理', accountant: '會計', gm: '總經理', other: '其他' };
const TYPE_OPTS = ['housekeeper', 'roomservice', 'manager', 'accountant', 'gm', 'other'];
const ROLE_LABEL: Record<string, string> = { super_admin: '總經理', manager: '主管', accountant: '會計', housekeeper: '一般' };
// 職位 → 權限 一對一。職位是主軸,權限由職位決定,不再各改各的 ——
// 原本兩欄各自可改,結果同一個人可以是「管家職位 + 管理員權限」,對不起來。
const ROLE_OF: Record<string, string> = {
  housekeeper: 'housekeeper', roomservice: 'housekeeper', manager: 'manager',
  accountant: 'accountant', gm: 'super_admin', other: 'housekeeper',
};

export default function AdminPage() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [role, setRole] = useState<string | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [payAccounts, setPayAccounts] = useState<PayAccount[]>([]);
  const [selEstate, setSelEstate] = useState<string>('');
  const [newPropName, setNewPropName] = useState('');
  const [msg, setMsg] = useState('');
  const [acct, setAcct] = useState<{ staffId: string; name: string; mode: 'create' | 'password'; email: string; password: string; role: string } | null>(null);

  const load = useCallback(async () => {
    const { data: st } = await supabase.from('staff').select('*').order('sort').order('name');
    const { data: pf } = await supabase.from('profiles').select('id, name, role, active');
    const { data: es } = await supabase.from('estates').select('*').order('sort').order('name');
    const { data: pr } = await supabase.from('properties').select('id, name, estate_id').order('name');
    const { data: pa } = await supabase.from('payment_accounts').select('*').order('sort').order('code');
    setStaff(st ?? []);
    setProfiles(pf ?? []);
    setEstates(es ?? []);
    setProperties(pr ?? []);
    setPayAccounts(pa ?? []);
    setSelEstate((cur) => cur || es?.[0]?.id || '');
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
  // 有登入帳號(profiles)但名冊(staff)沒有對應列的孤兒帳號 —— 多半是直接用 SQL 建的
  const orphanAccounts = useMemo(() => {
    const linked = new Set(staff.map((s) => s.auth_uid).filter(Boolean));
    return profiles.filter((p) => !linked.has(p.id));
  }, [staff, profiles]);
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffType, setNewStaffType] = useState('housekeeper');

  async function addStaff() {
    const name = newStaffName.trim();
    if (!name) return;
    const { error } = await supabase.from('staff')
      .insert({ name, staff_type: newStaffType, role: ROLE_OF[newStaffType], active: true, sort: 50 });
    if (error) return flash('新增失敗:' + error.message);
    setNewStaffName(''); flash('已新增 ' + name); load();
  }
  // 改職位時連權限一起改 —— 兩者一對一,分開改遲早會不同步
  async function changeStaffType(s: Staff, staff_type: string) {
    const role = ROLE_OF[staff_type];
    const { error } = await supabase.from('staff').update({ staff_type, role }).eq('id', s.id);
    if (error) return flash('更新失敗:' + error.message);
    // 有登入帳號的人還要同步 profiles.role,否則權限不會真的生效
    if (s.auth_uid) { await callAcct({ action: 'role', staffId: s.id, role }); return; }
    flash('已更新'); load();
  }
  async function updateStaff(id: string, patch: Partial<Staff>) {
    const { error } = await supabase.from('staff').update(patch).eq('id', id);
    if (error) return flash('更新失敗:' + error.message);
    flash('已更新'); load();
  }
  async function callAcct(payload: Record<string, unknown>): Promise<boolean> {
    const { data: { session } } = await supabase.auth.getSession();
    const r = await fetch('/api/admin/staff-account', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (session?.access_token || '') }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { flash('失敗:' + (j.error || r.status)); return false; }
    flash('已更新'); load(); return true;
  }
  async function toggleActive(s: Staff) {
    const { error } = await supabase.from('staff').update({ active: !s.active }).eq('id', s.id);
    if (error) return flash('更新失敗:' + error.message);
    if (s.auth_uid) await callAcct({ action: 'ban', staffId: s.id, ban: s.active });
    else { flash(s.active ? '已設為離職' : '已恢復在職'); load(); }
  }
  async function saveAcct() {
    if (!acct) return;
    if (acct.mode === 'create') {
      if (!acct.email.trim() || !acct.password) return flash('請填 email 與密碼');
      if (acct.password.length < 6) return flash('密碼至少 6 碼');
      if (await callAcct({ action: 'create', staffId: acct.staffId, email: acct.email.trim(), password: acct.password, role: acct.role })) setAcct(null);
    } else {
      if (acct.password.length < 6) return flash('密碼至少 6 碼');
      if (await callAcct({ action: 'password', staffId: acct.staffId, password: acct.password })) setAcct(null);
    }
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

  // ---- 收付款帳號 ----
  const [newAcctMethod, setNewAcctMethod] = useState('transfer');
  const [newAcctCode, setNewAcctCode] = useState('');
  const [newAcctName, setNewAcctName] = useState('');

  async function addPayAccount() {
    const code = newAcctCode.trim();
    const name = newAcctName.trim() || code;
    if (!code) return flash('請填代號');
    const { error } = await supabase.from('payment_accounts').insert({
      method: newAcctMethod, code, name,
      for_income: newAcctMethod === 'transfer',   // 信用卡預設只用於付款
      for_payment: true, sort: 50,
    });
    if (error) return flash('新增失敗:' + error.message);
    setNewAcctCode(''); setNewAcctName(''); flash('已新增 ' + code); load();
  }
  async function updatePayAccount(id: string, patch: Partial<PayAccount>) {
    const { error } = await supabase.from('payment_accounts').update(patch).eq('id', id);
    if (error) return flash('更新失敗:' + error.message);
    flash('已更新'); load();
  }
  async function deletePayAccount(a: PayAccount) {
    if (!confirm(`確定刪除帳號「${a.code}」?已經記在訂單或支出上的資料不會跟著改,那些紀錄會找不到對應帳號。建議改用「停用」。`)) return;
    const { error } = await supabase.from('payment_accounts').delete().eq('id', a.id);
    if (error) return flash('刪除失敗:' + error.message);
    flash('已刪除'); load();
  }

  // ---- 房源 ----
  async function addProperty() {
    const name = newPropName.trim();
    if (!name || !selEstate) return;
    const { error } = await supabase.from('properties').insert({ name, estate_id: selEstate });
    if (error) return flash('新增失敗:' + error.message);
    setNewPropName(''); flash('已新增 ' + name); load();
  }
  async function updateProperty(id: string, patch: Partial<Property>) {
    const { error } = await supabase.from('properties').update(patch).eq('id', id);
    if (error) return flash('更新失敗:' + error.message);
    flash('已更新'); load();
  }
  async function deleteProperty(id: string, name: string) {
    if (!confirm(`確定刪除房源「${name}」?(訂單/評價/清潔的房源文字仍保留)`)) return;
    const { error } = await supabase.from('properties').delete().eq('id', id);
    if (error) return flash('刪除失敗(可能仍有紀錄綁定):' + error.message);
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
                <th className="px-4 py-2.5">權限</th>
                <th className="px-4 py-2.5">帳號</th>
                <th className="px-4 py-2.5">狀態</th>
                <th className="px-4 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id} className={`border-b border-mor-line/60 last:border-0 ${s.active ? '' : 'opacity-50'}`}>
                  <td className="px-4 py-2 font-medium">{s.name}{s.aliases?.length ? <span className="ml-1 text-xs text-gray-400">({s.aliases.join('/')})</span> : null}</td>
                  <td className="px-4 py-2">
                    <select value={s.staff_type} disabled={!s.active} onChange={(e) => changeStaffType(s, e.target.value)}
                      className="rounded-lg border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-100 disabled:cursor-not-allowed">
                      {TYPE_OPTS.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <span className="text-sm">{ROLE_LABEL[s.role ?? 'housekeeper'] ?? s.role}</span>
                    <span className="ml-1 text-xs text-gray-400">(依職位)</span>
                  </td>
                  <td className="px-4 py-2">
                    {s.auth_uid ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">{s.email}</span>
                        <button onClick={() => setAcct({ staffId: s.id, name: s.name, mode: 'password', email: s.email ?? '', password: '', role: s.role ?? 'housekeeper' })} className="text-xs text-mor-slate underline hover:text-mor-blue">改密碼</button>
                      </div>
                    ) : (
                      <button onClick={() => setAcct({ staffId: s.id, name: s.name, mode: 'create', email: `u${s.id.slice(0, 8)}@justwork.estia.com.tw`, password: '', role: s.role ?? 'housekeeper' })} className="text-xs text-mor-blue underline">建立登入</button>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${s.active ? 'bg-mor-greenlight text-mor-green' : 'bg-gray-100 text-gray-400'}`}>
                      {s.active ? '在職' : '離職'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => toggleActive(s)}
                      className="text-xs text-mor-slate underline hover:text-mor-blue">
                      {s.active ? '設為離職' : '恢復在職'}
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
              {TYPE_OPTS.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
            <button onClick={addStaff} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增人員</button>
          </div>
        </div>
        {orphanAccounts.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
            <div className="font-medium text-amber-800 mb-1">有 {orphanAccounts.length} 個登入帳號未對應到人員名冊</div>
            <ul className="text-xs text-amber-700 space-y-0.5">
              {orphanAccounts.map((p) => (
                <li key={p.id}>{p.name || '(未命名)'} · {ROLE_LABEL[p.role] ?? p.role}</li>
              ))}
            </ul>
            <p className="text-xs text-amber-600 mt-1.5">這些帳號可以登入,但無法在此頁編輯。請執行補建 SQL(migration_31)。</p>
          </div>
        )}
        <p className="text-xs text-gray-400 mt-2">停用=離職:紀錄保留、可查詢,但從統計列表排除;總數仍計入營運總量。離職會同時停用網站登入(封鎖帳號),恢復在職則解除。權限由職位自動決定,不能單獨改:管家/房務→一般、經理→主管、會計→會計、總經理→super admin。各權限看得到的頁面:總經理=全部含設定;主管=營收/評價/清潔/訂單/請款/支出;會計=營收/請款/支出;一般=清潔/評價/訂單/請款。只有職位「管家」會出現在物業負責人下拉。</p>
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
                <th className="px-4 py-2.5">狀態</th>
                <th className="px-4 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {estates.map((e) => (
                <tr key={e.id} className={`border-b border-mor-line/60 last:border-0 ${e.active ? '' : 'opacity-50'}`}>
                  <td className="px-4 py-2 font-medium">{e.name}</td>
                  <td className="px-4 py-2">
                    <select value={e.manager ?? ''} disabled={!e.active} onChange={(ev) => updateEstate(e.id, { manager: ev.target.value || null })}
                      className="rounded-lg border border-gray-300 px-2 py-1 text-sm min-w-24 disabled:bg-gray-100">
                      <option value="">未指派</option>
                      {activeHousekeepers.map((h) => <option key={h.id} value={h.name}>{h.name}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <input type="number" defaultValue={e.sort} onBlur={(ev) => { const v = parseInt(ev.target.value); if (v !== e.sort) updateEstate(e.id, { sort: v }); }}
                      className="rounded-lg border border-gray-300 px-2 py-1 w-16 text-sm" />
                  </td>
                  <td className="px-4 py-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${e.active ? 'bg-mor-greenlight text-mor-green' : 'bg-gray-100 text-gray-400'}`}>{e.active ? '啟用' : '停用'}</span>
                  </td>
                  <td className="px-4 py-2 text-right space-x-3">
                    <button onClick={() => updateEstate(e.id, { active: !e.active })} className="text-xs text-mor-slate underline hover:text-mor-blue">{e.active ? '停用' : '啟用'}</button>
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
        <p className="text-xs text-gray-400 mt-2">停用物業:不顯示在評價/清潔的評分與篩選、也不需指派(紀錄仍保留)。負責管家換人後,該物業所有評價(含過去)歸現任。排序越小越前。</p>
      </section>

      {/* ===== 收付款帳號 ===== */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">收付款帳號</h2>
        <div className="bg-white rounded-xl border border-mor-line overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-mor-sand/40">
                <th className="px-4 py-2.5">方式</th>
                <th className="px-4 py-2.5">代號</th>
                <th className="px-4 py-2.5">顯示名稱</th>
                <th className="px-4 py-2.5 text-center">可收款</th>
                <th className="px-4 py-2.5 text-center">可付款</th>
                <th className="px-4 py-2.5 w-20">排序</th>
                <th className="px-4 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {payAccounts.map((a) => (
                <tr key={a.id} className={`border-b border-mor-line/60 last:border-0 ${a.active ? '' : 'opacity-50'}`}>
                  <td className="px-4 py-2">{METHOD_LABEL[a.method] ?? a.method}</td>
                  <td className="px-4 py-2 font-medium">{a.code}</td>
                  <td className="px-4 py-2">
                    <input defaultValue={a.name}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== a.name) updatePayAccount(a.id, { name: v }); }}
                      className="rounded-lg border border-gray-300 px-2 py-1 w-44" />
                  </td>
                  <td className="px-4 py-2 text-center">
                    <input type="checkbox" checked={a.for_income} className="w-4 h-4"
                      onChange={(e) => updatePayAccount(a.id, { for_income: e.target.checked })} />
                  </td>
                  <td className="px-4 py-2 text-center">
                    <input type="checkbox" checked={a.for_payment} className="w-4 h-4"
                      onChange={(e) => updatePayAccount(a.id, { for_payment: e.target.checked })} />
                  </td>
                  <td className="px-4 py-2">
                    <input type="number" defaultValue={a.sort}
                      onBlur={(e) => { const v = parseInt(e.target.value); if (v !== a.sort) updatePayAccount(a.id, { sort: v }); }}
                      className="rounded-lg border border-gray-300 px-2 py-1 w-16 text-sm" />
                  </td>
                  <td className="px-4 py-2 text-right space-x-3">
                    <button onClick={() => updatePayAccount(a.id, { active: !a.active })} className="text-xs text-mor-slate underline hover:text-mor-blue">{a.active ? '停用' : '啟用'}</button>
                    <button onClick={() => deletePayAccount(a)} className="text-xs text-red-500 underline hover:text-red-700">刪除</button>
                  </td>
                </tr>
              ))}
              {payAccounts.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">尚無帳號</td></tr>
              )}
            </tbody>
          </table>
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-mor-line bg-mor-sand/20 text-sm">
            <select value={newAcctMethod} onChange={(e) => setNewAcctMethod(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
              <option value="transfer">匯款</option>
              <option value="credit_card">信用卡</option>
            </select>
            <input value={newAcctCode} onChange={(e) => setNewAcctCode(e.target.value)} placeholder="代號(如 8088)"
              className="rounded-lg border border-gray-300 px-2 py-1.5 w-32" />
            <input value={newAcctName} onChange={(e) => setNewAcctName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addPayAccount(); }}
              placeholder="顯示名稱(如 元大 8088)" className="rounded-lg border border-gray-300 px-2 py-1.5 w-44" />
            <button onClick={addPayAccount} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增帳號</button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          支付方式(現金/匯款/信用卡/加密貨幣)是固定的,這裡管的是匯款與信用卡底下的帳號。
          「可收款」決定它出不出現在短租與契約的入款選單;「可付款」決定它出不出現在請款與支出。
          <b>代號一旦有交易掛上就不要再改</b> —— 訂單與支出存的是代號,改了舊資料會對不到,要調整標示請改顯示名稱。不再使用的帳號請用「停用」而非刪除。
        </p>
      </section>

      {/* ===== 房源管理 ===== */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">房源管理</h2>
        <div className="flex items-center gap-2 mb-2 text-sm">
          <span className="text-xs text-gray-500">物業</span>
          <select value={selEstate} onChange={(e) => setSelEstate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}{e.active ? '' : '(停用)'}</option>)}
          </select>
          <span className="text-xs text-gray-400">共 {properties.filter((p) => p.estate_id === selEstate).length} 間</span>
        </div>
        <div className="bg-white rounded-xl border border-mor-line overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-mor-sand/40">
                <th className="px-4 py-2.5">房源名稱(點擊可改名)</th>
                <th className="px-4 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {properties.filter((p) => p.estate_id === selEstate).map((p) => (
                <tr key={p.id} className="border-b border-mor-line/60 last:border-0">
                  <td className="px-4 py-2">
                    <input defaultValue={p.name} onBlur={(ev) => { const v = ev.target.value.trim(); if (v && v !== p.name) updateProperty(p.id, { name: v }); }}
                      className="rounded-lg border border-gray-300 px-2 py-1 w-64" />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => deleteProperty(p.id, p.name)} className="text-xs text-red-500 underline hover:text-red-700">刪除</button>
                  </td>
                </tr>
              ))}
              {properties.filter((p) => p.estate_id === selEstate).length === 0 && (
                <tr><td colSpan={2} className="px-4 py-6 text-center text-gray-400">此物業尚無房源</td></tr>
              )}
            </tbody>
          </table>
          <div className="flex items-center gap-2 px-4 py-3 border-t border-mor-line bg-mor-sand/20 text-sm">
            <input value={newPropName} onChange={(e) => setNewPropName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addProperty(); }}
              placeholder="新房源名稱" className="rounded-lg border border-gray-300 px-2 py-1.5 w-40" />
            <button onClick={addProperty} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增房源</button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-2">直接點房源名稱即可改名(改完點空白處儲存)。改名不影響已連結的訂單/評價(用 ID 綁定)。</p>
      </section>

      {acct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setAcct(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between">{acct.mode === 'create' ? `建立登入帳號 · ${acct.name}` : `更換密碼 · ${acct.name}`}<button onClick={() => setAcct(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button></div>
            <div className="px-6 py-4 flex flex-col gap-3 text-sm">
              {acct.mode === 'create' && (
                <>
                  <label className="flex flex-col gap-1">登入 email<input value={acct.email} onChange={(e) => setAcct({ ...acct, email: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" placeholder="name@justwork.estia.com.tw" /></label>
                  <div className="flex flex-col gap-1">權限<div className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-gray-600">{ROLE_LABEL[acct.role] ?? acct.role}<span className="ml-1 text-xs text-gray-400">(依職位自動決定)</span></div></div>
                </>
              )}
              <label className="flex flex-col gap-1">{acct.mode === 'create' ? '設定密碼' : '新密碼'}(至少 6 碼)<input type="text" value={acct.password} onChange={(e) => setAcct({ ...acct, password: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" placeholder="輸入密碼" autoComplete="new-password" /></label>
              <p className="text-xs text-gray-400">密碼由你設定;人員用此 email + 密碼登入。之後可在此更換。</p>
            </div>
            <div className="border-t border-mor-line px-6 py-3 flex justify-end gap-2">
              <button onClick={() => setAcct(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={saveAcct} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark">{acct.mode === 'create' ? '建立帳號' : '更換密碼'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
