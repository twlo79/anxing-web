'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import { guessLink, rankNames } from '@/lib/hk-link';

/**
 * 房務設定中心。
 *
 * 設計原則:所有規則、對照、名單都是資料,不是程式碼。
 * 新增人員、新房源、改床數、改工作類型,全部在這裡完成,不需要改版佈署。
 *
 * 改設定不改歷史 —— 改幾床只影響「之後重算」的結果,
 * 已經下載的報表不會回頭變動。
 */

type Staff = {
  id: string; source_names: string[]; code: string; name: string;
  count_mode: 'rooms' | 'hours' | 'none'; count_cleans: boolean;
  color: string | null; color_text: string | null; color_bar: string | null;
  leave_prefix: string | null; active: boolean; sort: number;
  staff_id: string | null;
};
type Prop = {
  id: string; code: string; name: string | null; aliases: string[];
  beds: number | null; linen_group: string; count_linen: boolean;
  ptype: string; active: boolean; sort: number;
  property_id: string | null;
};
/**
 * ERP 主檔。這一頁只用來「對應」，不編輯它們。
 *
 * 對應關係是事實，不是規則 —— 「開4」跟「開封4F」是不是同一間，
 * 只有人知道。程式去猜的話，猜錯了工作會被指派到別間房，
 * 而排班表看起來滿滿的，沒有人會發現。問一次，存起來。
 */
type ErpProp = { id: string; name: string; clean_points: number | null };
type ErpStaff = { id: string; name: string };

type WType = { code: string; name: string; count_workload: boolean; count_linen: boolean; sort: number; active: boolean };
type Setting = { key: string; value: string | null; vtype: string; options: string[] | null; description: string | null; sort: number };
/** 設定層的異動紀錄。changes 格式:{欄位: [改前, 改後]} */
type Audit = { id: number; table_name: string; record_key: string; action: string; changes: any; at: string };

const MODE_LABEL: Record<string, string> = { rooms: '計間數', hours: '計時數', none: '不統計' };
const GROUP_LABEL: Record<string, string> = { kai: '開整棟系', ab: '時兆', zl: '正隆', other: '其他' };
const PTYPE_LABEL: Record<string, string> = { room: '房間', building: '整棟', common_area: '公區', other: '其他' };
const TABLE_LABEL: Record<string, string> = {
  hk_staff: '人員', hk_property: '房源', hk_work_type: '工作類型', hk_setting: '系統參數',
};
const ACTION_LABEL: Record<string, string> = { insert: '新增', update: '修改', delete: '刪除' };

/** 相對亮度 → 對比度。WCAG AA 要求正文 >= 4.5:1 */
function contrast(bg: string, fg: string) {
  const lum = (hex: string) => {
    const h = hex.replace('#', '');
    if (h.length !== 6) return 1;
    const v = [0, 2, 4].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const a = lum(bg), b = lum(fg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export default function HkSettingsPage() {
  const supabase = createClient();
  const [tab, setTab] = useState<'staff' | 'property' | 'wtype' | 'setting' | 'audit'>('staff');
  const [staff, setStaff] = useState<Staff[]>([]);
  const [props, setProps] = useState<Prop[]>([]);
  const [wtypes, setWtypes] = useState<WType[]>([]);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [erpProps, setErpProps] = useState<ErpProp[]>([]);
  const [erpStaff, setErpStaff] = useState<ErpStaff[]>([]);
  const [msg, setMsg] = useState('');
  const [kw, setKw] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 3000); }

  const load = useCallback(async () => {
    const [s, p, w, st, au, ep, es] = await Promise.all([
      supabase.from('hk_staff').select('*').order('sort'),
      supabase.from('hk_property').select('*').order('sort'),
      supabase.from('hk_work_type').select('*').order('sort'),
      supabase.from('hk_setting').select('*').order('sort'),
      supabase.from('hk_audit').select('*').order('at', { ascending: false }).limit(200),
      supabase.from('properties').select('id, name, clean_points').eq('active', true).order('name'),
      supabase.from('staff').select('id, name').eq('active', true).order('name'),
    ]);
    setStaff((s.data ?? []) as Staff[]);
    setProps((p.data ?? []) as Prop[]);
    setWtypes((w.data ?? []) as WType[]);
    setSettings((st.data ?? []) as Setting[]);
    setAudits((au.data ?? []) as Audit[]);
    setErpProps((ep.data ?? []) as ErpProp[]);
    setErpStaff((es.data ?? []) as ErpStaff[]);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  /** 樂觀更新:畫面先動,失敗才回滾。設定頁的每個欄位都是即時存檔,沒有儲存按鈕。 */
  async function patch<T extends { [k: string]: any }>(
    table: string, keyCol: string, keyVal: string, p: Partial<T>,
    setter: React.Dispatch<React.SetStateAction<T[]>>,
  ) {
    setter((rows) => rows.map((r) => (r[keyCol] === keyVal ? { ...r, ...p } : r)));
    // as any:supabase-js 的 update() 帶 RejectExcessProperties 約束,
    // 對上這裡的泛型 Partial<T> 推不出來。這幾張表沒有產生型別定義,
    // 型別安全本來就落在呼叫端。
    const { error } = await supabase.from(table).update(p as any).eq(keyCol, keyVal);
    if (error) { flash('儲存失敗:' + error.message); load(); }
  }

  /*
   * 已經被別人佔走的 ERP 房源／員工。
   *
   * 資料庫有唯一索引擋著（一間 ERP 房源只能被一個房務代碼對到），
   * 但等到按下去才跳「duplicate key」的話，看的人只會覺得壞了。
   * 選單裡直接標「已對應：開4」——**看得到為什麼不能選**。
   */
  const takenProp = useMemo(
    () => new Map(props.filter((p) => p.property_id).map((p) => [p.property_id!, p.code])), [props]);
  const takenStaff = useMemo(
    () => new Map(staff.filter((s) => s.staff_id).map((s) => [s.staff_id!, s.name])), [staff]);

  /*
   * 對應提示。24 個代碼各自到 70 個房源的選單裡找一遍是會亂點的,
   * 而亂點跟讓程式猜是同一個結果 —— 所以把最可能的講出來,
   * 選單也把對得上的排到最前面,但按下去的還是人。
   * 判斷規則與測試在 lib/hk-link.ts。
   */
  const erpPropNames = useMemo(() => erpProps.map((e) => e.name), [erpProps]);
  const erpStaffNames = useMemo(() => erpStaff.map((e) => e.name), [erpStaff]);

  const inp = 'rounded border border-gray-300 px-2 py-1 text-sm';
  const th = 'px-3 py-2 text-left text-xs text-gray-500 font-medium';
  const td = 'px-3 py-1.5';

  const filteredProps = useMemo(() => props.filter((p) => {
    if (!showInactive && !p.active) return false;
    if (!kw) return true;
    const hay = `${p.code} ${p.name ?? ''} ${(p.aliases ?? []).join(' ')}`.toLowerCase();
    return hay.includes(kw.toLowerCase());
  }), [props, kw, showInactive]);

  // ── 新增 ───────────────────────────────────────────
  async function addStaff() {
    const name = prompt('顯示名（例:小美）'); if (!name) return;
    const code = prompt('系統代號（例:MEI）', name); if (!code) return;
    const src = prompt('排班表上的顯示名（要跟排班系統上一模一樣）', name); if (!src) return;
    const { error } = await supabase.from('hk_staff').insert({
      source_names: [src], code, name,
      count_mode: 'rooms', count_cleans: true,
      color: 'E7E6E6', color_text: '3F3F3F', color_bar: 'A6A6A6',
      sort: (staff.at(-1)?.sort ?? 0) + 1,
    });
    if (error) return flash('新增失敗:' + error.message);
    flash('已新增,記得設定顏色與計法'); load();
  }

  async function addProp() {
    const code = prompt('房源代碼（例:20B1）'); if (!code) return;
    const beds = prompt('幾床（公區填 0）', '1');
    const { error } = await supabase.from('hk_property').insert({
      code, beds: beds === '' || beds == null ? null : Number(beds),
      linen_group: 'other', sort: 500,
    });
    if (error) return flash('新增失敗:' + error.message);
    flash('已新增,記得指定布巾表'); load();
  }

  return (
    <div>
      {msg && <div className="mb-3 rounded-lg bg-mor-greenlight text-mor-green px-3 py-2 text-sm">{msg}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Link href="/housekeeping" className="text-sm text-mor-blue underline mr-2">← 回排班表</Link>
        {([['staff', '人員'], ['property', '房源'], ['wtype', '工作類型'],
           ['setting', '系統參數'], ['audit', '異動紀錄']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 h-10 rounded-lg text-sm font-medium ${tab === k ? 'bg-mor-slate text-white' : 'bg-white border border-mor-line text-gray-600'}`}>
            {l}
          </button>
        ))}
      </div>

      {/* ── 人員 ───────────────────────────────── */}
      {tab === 'staff' && (
        <div className="rounded-xl glass overflow-x-auto">
          <div className="px-4 py-2.5 border-b border-mor-line bg-white/45 flex items-center justify-between">
            <span className="text-sm font-medium">人員主檔</span>
            <button onClick={addStaff} className="text-xs text-mor-blue underline">+ 新增人員</button>
          </div>
          <div className="px-4 py-2 text-xs text-gray-400 border-b border-mor-line/40">
            <b>計間數</b> = 出現在排班表的間數欄（Una、庭玉）・
            <b>計時數</b> = 只填時數,不算間數（劉姐）・
            <b>不統計</b> = 事件不匯入（入住準備組）。
            「計打掃次數」獨立於上面三者 —— 劉姐不算間數,但她掃的房間床單確實被換掉了,不算會少領。
          </div>
          {/* 手機放不下這幾欄 —— 沒有這層捲軸容器，欄位會被壓到只剩幾個 px 而不是可以滑動 */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead><tr className="border-b border-mor-line/60">
                <th className={th}>顯示名</th><th className={th}>代號</th>
                <th className={th}>對應 ERP 員工</th>
                <th className={th}>排班表上的名稱</th><th className={th}>計法</th>
                <th className={th}>計打掃次數</th><th className={th}>休假前綴</th>
                <th className={th}>顏色</th><th className={th}>啟用</th>
              </tr></thead>
              <tbody>
                {staff.map((s) => {
                  const bg = `#${s.color ?? 'EEEEEE'}`, fg = `#${s.color_text ?? '333333'}`;
                  const ratio = contrast(bg, fg);
                  return (
                    <tr key={s.id} className={`border-b border-mor-line/40 last:border-0 ${s.active ? '' : 'opacity-40'}`}>
                      <td className={td}><input value={s.name} onChange={(e) => patch('hk_staff', 'id', s.id, { name: e.target.value }, setStaff)} className={`${inp} w-24`} /></td>
                      <td className={td}><input value={s.code} onChange={(e) => patch('hk_staff', 'id', s.id, { code: e.target.value }, setStaff)} className={`${inp} w-20`} /></td>
                      <td className={td}>
                        <select value={s.staff_id ?? ''}
                          onChange={(e) => patch('hk_staff', 'id', s.id, { staff_id: e.target.value || null }, setStaff)}
                          className={`${inp} w-32 ${s.staff_id ? '' : 'border-amber-400 bg-amber-50'}`}>
                          <option value="">— 還沒對應 —</option>
                          {rankNames(s.name, s.source_names ?? [], erpStaffNames).map((nm) => {
                            const es = erpStaff.find((e) => e.name === nm)!;
                            const by = takenStaff.get(es.id);
                            return (
                              <option key={es.id} value={es.id} disabled={!!by && by !== s.name}>
                                {es.name}{by && by !== s.name ? `（已對應 ${by}）` : ''}
                              </option>
                            );
                          })}
                        </select>
                        {!s.staff_id && (() => {
                          const g = guessLink(s.name, s.source_names ?? [], erpStaffNames);
                          if (!g) return null;
                          const es = erpStaff.find((e) => e.name === g)!;
                          if (takenStaff.has(es.id)) return null;
                          return (
                            <button onClick={() => patch('hk_staff', 'id', s.id, { staff_id: es.id }, setStaff)}
                              className="block mt-1 text-xs text-mor-blue underline">
                              是不是「{g}」？
                            </button>
                          );
                        })()}
                      </td>
                      <td className={td}>
                        {/* 陣列:排班系統上的顯示名會改,舊事件裡兩種寫法會並存 */}
                        <input value={(s.source_names ?? []).join(', ')}
                          onChange={(e) => patch('hk_staff', 'id', s.id, {
                            source_names: e.target.value.split(',').map((x) => x.trim()).filter(Boolean),
                          }, setStaff)}
                          placeholder="多個用逗號分隔" className={`${inp} w-52`} />
                      </td>
                      <td className={td}>
                        <select value={s.count_mode} onChange={(e) => patch('hk_staff', 'id', s.id, { count_mode: e.target.value as any }, setStaff)} className={inp}>
                          {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </td>
                      <td className={td}>
                        <input type="checkbox" checked={s.count_cleans} onChange={(e) => patch('hk_staff', 'id', s.id, { count_cleans: e.target.checked }, setStaff)} />
                      </td>
                      <td className={td}><input value={s.leave_prefix ?? ''} onChange={(e) => patch('hk_staff', 'id', s.id, { leave_prefix: e.target.value || null }, setStaff)} placeholder="U休" className={`${inp} w-16`} /></td>
                      <td className={td}>
                        <div className="flex items-center gap-1">
                          <span className="inline-block rounded px-2 py-0.5 text-xs border-l-4"
                            style={{ backgroundColor: bg, color: fg, borderLeftColor: `#${s.color_bar ?? '999999'}` }}>範例</span>
                          {(['color', 'color_text', 'color_bar'] as const).map((f) => (
                            <input key={f} type="color" value={`#${(s[f] as string) ?? '000000'}`}
                              onChange={(e) => patch('hk_staff', 'id', s.id, { [f]: e.target.value.slice(1).toUpperCase() } as any, setStaff)}
                              title={f === 'color' ? '底色' : f === 'color_text' ? '文字' : '左側色條'}
                              className="w-6 h-6 rounded border border-gray-300 p-0" />
                          ))}
                          {/* WCAG AA 要求 4.5:1。色盲使用者靠左側色條分辨,對比不足只是難讀不是不能用 */}
                          {ratio < 4.5 && <span className="text-[10px] text-amber-600" title={`對比 ${ratio.toFixed(1)}:1，建議 ≥ 4.5`}>對比不足</span>}
                        </div>
                      </td>
                      <td className={td}>
                        {/* 停用而非刪除:歷史報表要保留這個人的資料 */}
                        <input type="checkbox" checked={s.active} onChange={(e) => patch('hk_staff', 'id', s.id, { active: e.target.checked }, setStaff)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 房源 ───────────────────────────────── */}
      {tab === 'property' && (
        <div className="rounded-xl glass overflow-x-auto">
          <div className="px-4 py-2.5 border-b border-mor-line bg-white/45 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium mr-auto">房源主檔（{filteredProps.length}）</span>
            <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜尋代碼或別名" className={`${inp} w-40`} />
            <label className="flex items-center gap-1 text-xs text-gray-500">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />含停用
            </label>
            <button onClick={addProp} className="text-xs text-mor-blue underline">+ 新增房源</button>
          </div>
          <div className="px-4 py-2 text-xs text-gray-400 border-b border-mor-line/40">
            <b>對應 ERP 房源</b>沒選的話,這個房源的排班套不到行事曆上,也算不出打掃報酬 ——
            黃框就是還沒對的。公區類的本來就沒有對應的 ERP 房源,留空即可。
            <b>打掃點數</b>要改請到「權限管理 → 房源管理」,整棟／整層是各層加總的,不用手填。<br />
            <b>別名</b>會在解析標題時一併比對 —— 例外清單出現「未識別房源」時,多半是這裡少一個別名。
            <b>幾床</b>留白代表尚未建檔,會在例外清單提醒;填 0 代表確定不算床（公區）。
            改幾床只影響之後的重算,已下載的報表不會變動。
          </div>
          {/* 手機放不下這幾欄 —— 沒有這層捲軸容器，欄位會被壓到只剩幾個 px 而不是可以滑動 */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead><tr className="border-b border-mor-line/60">
                <th className={th}>代碼</th><th className={th}>對應 ERP 房源</th>
                <th className={th}>打掃點數</th><th className={th}>別名</th>
                <th className={th}>幾床</th><th className={th}>布巾表</th>
                <th className={th}>類型</th><th className={th}>計布巾</th><th className={th}>啟用</th>
              </tr></thead>
              <tbody>
                {filteredProps.map((p) => (
                  <tr key={p.id} className={`border-b border-mor-line/40 last:border-0 ${p.active ? '' : 'opacity-40'}`}>
                    <td className={td}><input value={p.code} onChange={(e) => patch('hk_property', 'id', p.id, { code: e.target.value }, setProps)} className={`${inp} w-24`} /></td>
                    <td className={td}>
                      <select value={p.property_id ?? ''}
                        onChange={(e) => patch('hk_property', 'id', p.id, { property_id: e.target.value || null }, setProps)}
                        className={`${inp} w-40 ${p.property_id || p.ptype === 'common_area' ? '' : 'border-amber-400 bg-amber-50'}`}>
                        <option value="">— 還沒對應 —</option>
                        {rankNames(p.code, p.aliases ?? [], erpPropNames).map((nm) => {
                          const ep = erpProps.find((e) => e.name === nm)!;
                          const by = takenProp.get(ep.id);
                          return (
                            <option key={ep.id} value={ep.id} disabled={!!by && by !== p.code}>
                              {ep.name}{by && by !== p.code ? `（已對應 ${by}）` : ''}
                            </option>
                          );
                        })}
                      </select>
                      {!p.property_id && (() => {
                        const g = guessLink(p.code, p.aliases ?? [], erpPropNames);
                        if (!g) return null;
                        const ep = erpProps.find((e) => e.name === g)!;
                        if (takenProp.has(ep.id)) return null;
                        return (
                          <button onClick={() => patch('hk_property', 'id', p.id, { property_id: ep.id }, setProps)}
                            className="block mt-1 text-xs text-mor-blue underline">
                            是不是「{g}」？
                          </button>
                        );
                      })()}
                    </td>
                    {/*
                      點數只顯示不編輯 —— 它掛在 ERP 房源上（權限管理 → 房源管理），
                      在這裡再開一個入口的話，兩邊會各改各的，而且看不出哪邊才算數。
                    */}
                    <td className={`${td} tabular-nums text-gray-500`}>
                      {p.property_id
                        ? (erpProps.find((e) => e.id === p.property_id)?.clean_points ?? '—')
                        : ''}
                    </td>
                    <td className={td}>
                      <input value={(p.aliases ?? []).join(', ')}
                        onChange={(e) => patch('hk_property', 'id', p.id, { aliases: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }, setProps)}
                        placeholder="多個用逗號分隔" className={`${inp} w-56`} />
                    </td>
                    <td className={td}>
                      <input type="number" min="0" value={p.beds ?? ''}
                        onChange={(e) => patch('hk_property', 'id', p.id, { beds: e.target.value === '' ? null : Number(e.target.value) }, setProps)}
                        className={`${inp} w-16 text-right ${p.beds == null ? 'bg-amber-50' : ''}`} />
                    </td>
                    <td className={td}>
                      <select value={p.linen_group} onChange={(e) => patch('hk_property', 'id', p.id, { linen_group: e.target.value }, setProps)} className={inp}>
                        {Object.entries(GROUP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </td>
                    <td className={td}>
                      <select value={p.ptype ?? 'room'} onChange={(e) => patch('hk_property', 'id', p.id, { ptype: e.target.value }, setProps)} className={inp}>
                        {Object.entries(PTYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </td>
                    <td className={td}><input type="checkbox" checked={p.count_linen !== false} onChange={(e) => patch('hk_property', 'id', p.id, { count_linen: e.target.checked }, setProps)} /></td>
                    <td className={td}><input type="checkbox" checked={p.active} onChange={(e) => patch('hk_property', 'id', p.id, { active: e.target.checked }, setProps)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 工作類型 ───────────────────────────── */}
      {tab === 'wtype' && (
        <div className="rounded-xl glass overflow-x-auto">
          <div className="px-4 py-2.5 border-b border-mor-line bg-white/45 text-sm font-medium">工作類型</div>
          <div className="px-4 py-2 text-xs text-gray-400 border-b border-mor-line/40">
            兩個開關是分開的:<b>計間數</b>影響個人工作量,<b>計布巾</b>影響床單推算。
            例如「贈品補充」算工作量但不一定換床單,可以只關後者。
            <div className="mt-1">
              改動立即生效,回排班表重新整理就會看到數字變動。
              計布巾還要看該房源自己的「計布巾」開關 —— 兩個都開才會進床單。
            </div>
          </div>
          {/* 手機放不下這幾欄 —— 沒有這層捲軸容器，欄位會被壓到只剩幾個 px 而不是可以滑動 */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="border-b border-mor-line/60">
                <th className={th}>類型</th><th className={th}>計間數</th><th className={th}>計布巾</th><th className={th}>啟用</th>
              </tr></thead>
              <tbody>
                {wtypes.map((w) => (
                  <tr key={w.code} className={`border-b border-mor-line/40 last:border-0 ${w.active ? '' : 'opacity-40'}`}>
                    <td className={td}>{w.name}</td>
                    <td className={td}><input type="checkbox" checked={w.count_workload} onChange={(e) => patch('hk_work_type', 'code', w.code, { count_workload: e.target.checked }, setWtypes)} /></td>
                    <td className={td}><input type="checkbox" checked={w.count_linen} onChange={(e) => patch('hk_work_type', 'code', w.code, { count_linen: e.target.checked }, setWtypes)} /></td>
                    <td className={td}><input type="checkbox" checked={w.active} onChange={(e) => patch('hk_work_type', 'code', w.code, { active: e.target.checked }, setWtypes)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 異動紀錄 ───────────────────────────── */}
      {tab === 'audit' && (
        <div className="rounded-xl glass overflow-x-auto">
          <div className="px-4 py-2.5 border-b border-mor-line bg-white/45 text-sm font-medium">
            異動紀錄（最近 200 筆）
          </div>
          <div className="px-4 py-2 text-xs text-gray-400 border-b border-mor-line/40">
            只記設定層的改動 —— 那些會<b>追溯影響所有月份</b>的計算（改幾床、改計布巾開關）。
            排班表上每天的增刪不記在這裡,那些在畫面上本來就看得到（虛線框 = 手動、✎ = 同步後被改過）。
          </div>
          {audits.length === 0 ? (
            <div className="px-4 py-10 text-center text-gray-400 text-sm">
              還沒有異動紀錄。到其他分頁改一個設定就會出現。
            </div>
          ) : (
            /* 外層那個 div 已經有 overflow-x-auto。min-w 是關鍵 ——
               沒有它，w-full 的表格會乖乖縮到 100%，欄位被壓到剩幾個 px 而永遠不觸發捲軸 */
            <div>
              <table className="w-full min-w-[760px] text-sm">
                <thead><tr className="border-b border-mor-line/60">
                  <th className={th}>時間</th><th className={th}>主檔</th>
                  <th className={th}>對象</th><th className={th}>動作</th><th className={th}>改了什麼</th>
                </tr></thead>
                <tbody>
                  {audits.map((a) => (
                    <tr key={a.id} className="border-b border-mor-line/40 last:border-0 align-top">
                      <td className={`${td} whitespace-nowrap text-gray-500 text-xs`}>
                        {a.at?.slice(0, 16).replace('T', ' ')}
                      </td>
                      <td className={`${td} text-xs text-gray-500`}>{TABLE_LABEL[a.table_name] ?? a.table_name}</td>
                      <td className={`${td} font-medium`}>{a.record_key}</td>
                      <td className={td}>
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${
                          a.action === 'insert' ? 'bg-mor-greenlight text-mor-green'
                          : a.action === 'delete' ? 'bg-red-50 text-red-600'
                          : 'bg-mor-bluelight text-mor-slate'}`}>
                          {ACTION_LABEL[a.action] ?? a.action}
                        </span>
                      </td>
                      <td className={`${td} text-xs`}>
                        {a.action === 'update' && a.changes
                          ? Object.entries(a.changes as Record<string, any>).map(([k, v]) => (
                              <div key={k}>
                                <span className="text-gray-400">{k}</span>{' '}
                                <span className="text-gray-500">{JSON.stringify(Array.isArray(v) ? v[0] : null)}</span>
                                {' → '}
                                <span className="font-medium">{JSON.stringify(Array.isArray(v) ? v[1] : v)}</span>
                              </div>
                            ))
                          : <span className="text-gray-400">整筆{ACTION_LABEL[a.action] ?? a.action}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── 系統參數 ───────────────────────────── */}
      {tab === 'setting' && (
        <div className="rounded-xl glass divide-y divide-mor-line/40">
          <div className="px-4 py-2.5 bg-white/45 text-sm font-medium">系統參數</div>
          {settings.map((s) => (
            <div key={s.key} className="px-4 py-3 flex flex-wrap items-start gap-3">
              <div className="flex-1 min-w-48">
                <div className="text-sm font-medium">{s.key}</div>
                <div className="text-xs text-gray-400 mt-0.5">{s.description}</div>
              </div>
              <div className="shrink-0">
                {s.vtype === 'bool' ? (
                  <input type="checkbox" checked={s.value === 'true'}
                    onChange={(e) => patch('hk_setting', 'key', s.key, { value: String(e.target.checked) }, setSettings)} />
                ) : s.vtype === 'enum' ? (
                  <select value={s.value ?? ''} onChange={(e) => patch('hk_setting', 'key', s.key, { value: e.target.value }, setSettings)} className={inp}>
                    {(s.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input value={s.value ?? ''} onChange={(e) => patch('hk_setting', 'key', s.key, { value: e.target.value }, setSettings)} className={`${inp} w-56`} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
