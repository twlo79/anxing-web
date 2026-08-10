'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { createClient } from '@/lib/supabase';
import { getPosition, type GeoFail } from '@/lib/punch';
import { twToday } from '@/lib/attendance-ui';
import {
  BTN, BTN2, CARD, INPUT, noRowsMsg,
  type Balance, type Estate, type LeaveType, type TabProps,
} from './types';

/**
 * 管理（主管／總經理）：打卡位置 · 個人上下班時間 · 假別額度 · 出勤表匯出。
 *
 * 四塊都是「設定一次、之後很少動」的東西，所以擠在同一個分頁，
 * 不再往下切。每天要用的在「打卡」，每週要看的在「核可」。
 */

type Sub = 'gps' | 'hours' | 'quota' | 'report';
const SUB: Record<Sub, string> = {
  gps: '打卡位置', hours: '上下班時間', quota: '假別額度', report: '出勤表',
};

type Person = {
  id: string; name: string; role: string; active: boolean;
  work_start: string | null; work_end: string | null;
  work_hours_per_day: number | null; hired_on: string | null;
};

export default function AdminTab({ onMsg }: TabProps) {
  const [sub, setSub] = useState<Sub>('gps');
  return (
    <div className="space-y-4">
      <div className="inline-flex gap-1 p-1 rounded-xl bg-white/45 backdrop-blur border border-white/60">
        {(Object.keys(SUB) as Sub[]).map((k) => (
          <button key={k} onClick={() => setSub(k)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              sub === k ? 'bg-white text-mor-slate shadow-[0_2px_8px_-2px_rgba(46,56,64,0.25)]' : 'text-gray-500 hover:text-gray-700'}`}>
            {SUB[k]}
          </button>
        ))}
      </div>
      {sub === 'gps' && <GpsSection onMsg={onMsg} />}
      {sub === 'hours' && <HoursSection onMsg={onMsg} />}
      {sub === 'quota' && <QuotaSection onMsg={onMsg} />}
      {sub === 'report' && <ReportSection onMsg={onMsg} />}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
 * 1. 打卡位置
 * ══════════════════════════════════════════════════════ */

/**
 * 【為什麼要有「用我現在的位置」】
 * 手打經緯度是災難：小數點第四位差一位就是十幾公尺，而且經緯度很容易填反
 * （台北的緯度是 25 開頭、經度是 121 開頭）。填反的話所有人都打不了卡，
 * 而錯誤訊息只會說「距離 8000 公尺」，沒有人會想到是座標的問題。
 *
 * 站在物業樓下按一下，比什麼都準。
 */
function GpsSection({ onMsg }: { onMsg: TabProps['onMsg'] }) {
  const supabase = useMemo(() => createClient(), []);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const { data } = await supabase.from('estates')
      .select('id, name, active, sort, gps_lat, gps_lng, gps_radius_m').order('sort').order('name');
    setEstates((data ?? []) as Estate[]);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  /**
   * 資料庫的 check constraint 訊息長這樣：
   *   new row for relation "estates" violates check constraint "estates_gps_range_chk"
   * 直接丟給使用者等於沒講。翻成他真正要做的事。
   */
  function explain(msg: string): string {
    if (msg.includes('estates_gps_range_chk')) {
      return '座標不在台灣範圍內，八成是經緯度填反了。\n\n'
        + '台灣的緯度是 21~26（25 開頭那個），經度是 119~123（121 開頭那個）。\n'
        + '不確定的話直接按「用我現在的位置」。';
    }
    if (msg.includes('estates_gps_radius_chk')) {
      return '半徑不能小於 50 公尺。\n\n'
        + '手機 GPS 在市區的誤差就有 10~50 公尺，半徑設太小會讓人站在門口卻打不了卡。';
    }
    return '存不進去：' + msg;
  }

  async function upd(e: Estate, patch: Partial<Estate>) {
    const { data, error } = await supabase.from('estates')
      .update(patch).eq('id', e.id).select('id');
    if (error) return onMsg(explain(error.message), true);
    // RLS 擋掉的 UPDATE 不會回錯誤，只會影響 0 列 ——
    // 不檢查的話畫面會顯示「已更新」，而其實什麼都沒存進去。
    if (!data?.length) return onMsg(noRowsMsg('打卡位置'), true);
    load();
  }

  async function useHere(e: Estate) {
    setBusy(e.id);
    try {
      const pos = await getPosition();
      const { data, error } = await supabase.from('estates')
        .update({ gps_lat: pos.lat, gps_lng: pos.lng }).eq('id', e.id).select('id');
      if (error) return onMsg(explain(error.message), true);
      if (!data?.length) return onMsg(noRowsMsg('打卡位置'), true);
      // 精度講出來 —— 誤差 2000 公尺的定位（基地台）設出來的位置沒有意義，
      // 而使用者只有看到數字才會知道要走到窗邊重按一次。
      const acc = Math.round(pos.accuracy);
      onMsg(acc > 100
        ? `「${e.name}」已設為你目前的位置，但這次定位的精度只有約 ${acc} 公尺 ——`
          + `站到戶外或窗邊再按一次會準很多。`
        : `「${e.name}」的打卡位置已設為你目前的位置（精度約 ${acc} 公尺）`);
      load();
    } catch (err) {
      onMsg((err as GeoFail)?.message ?? '拿不到位置', true);
    } finally { setBusy(''); }
  }

  return (
    <section>
      <div className={`${CARD} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-mor-line">
                <th className="px-4 py-2.5">物業</th>
                <th className="px-4 py-2.5">緯度</th>
                <th className="px-4 py-2.5">經度</th>
                <th className="px-4 py-2.5 w-28">半徑（公尺）</th>
                <th className="px-4 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {estates.filter((e) => e.active).map((e) => (
                <tr key={e.id} className="border-b border-mor-line/60 last:border-0">
                  <td className="px-4 py-2 font-medium">
                    {e.name}
                    {e.gps_lat == null && <span className="ml-2 text-[11px] text-amber-600">尚未設定</span>}
                  </td>
                  {(['gps_lat', 'gps_lng'] as const).map((k) => (
                    <td key={k} className="px-4 py-2">
                      <input type="number" step="0.000001" defaultValue={e[k] ?? ''}
                        onBlur={(ev) => {
                          const v = ev.target.value === '' ? null : Number(ev.target.value);
                          if (v !== e[k]) upd(e, { [k]: v } as Partial<Estate>);
                        }}
                        className="w-32 rounded border border-mor-line px-2 py-1 text-sm tabular-nums" />
                    </td>
                  ))}
                  <td className="px-4 py-2">
                    <input type="number" defaultValue={e.gps_radius_m}
                      onBlur={(ev) => {
                        const v = Number(ev.target.value) || 0;
                        if (v !== e.gps_radius_m) upd(e, { gps_radius_m: v });
                      }}
                      className="w-20 rounded border border-mor-line px-2 py-1 text-sm tabular-nums" />
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button onClick={() => useHere(e)} disabled={busy === e.id} className={BTN2}>
                      {busy === e.id ? '定位中…' : '📍 用我現在的位置'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════
 * 2. 個人上下班時間
 * ══════════════════════════════════════════════════════ */

/**
 * 【為什麼是每個人設，不是照職務】
 * 使用者指定「以個人設定，不要以職務設計」。同一個職務的兩個人
 * 可以有不同的班表，而職務級的設定會讓例外變成不能表達的東西。
 *
 * 留空 = 沿用全公司預設（work_settings）。這比讓每一列都填滿好 ——
 * 填滿的話改公司預設不會生效，而沒有人記得自己被個別設定過。
 */
function HoursSection({ onMsg }: { onMsg: TabProps['onMsg'] }) {
  const supabase = useMemo(() => createClient(), []);
  const [ppl, setPpl] = useState<Person[]>([]);
  const [ws, setWs] = useState<{
    work_start: string; work_end: string; work_hours_per_day: number;
    punch_before_min: number; punch_after_min: number;
  } | null>(null);

  const load = useCallback(async () => {
    const [{ data: p }, { data: w }] = await Promise.all([
      supabase.from('profiles')
        .select('id, name, role, active, work_start, work_end, work_hours_per_day, hired_on')
        .order('name'),
      supabase.from('work_settings').select('*').eq('id', 1).single(),
    ]);
    setPpl((p ?? []) as Person[]);
    setWs(w as typeof ws);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  /**
   * 班表走 set_work_time RPC，不直接 update profiles。
   *
   * profiles 上如果開了 update 的 RLS，主管就能改自己的 role ——
   * RLS 是列級的，沒辦法只開放某幾欄。函式只寫那四欄，碰不到 role。
   *
   * 四個值每次都整組送 —— null 代表「清空，沿用公司預設」，
   * 只送有變動的那一欄的話，資料庫分不出「沒帶」跟「要清空」。
   */
  async function updP(p: Person, patch: Partial<Person>) {
    const next = { ...p, ...patch };
    const { data, error } = await supabase.rpc('set_work_time', {
      p_user: p.id,
      p_start: next.work_start || null,
      p_end: next.work_end || null,
      p_hours: next.work_hours_per_day ?? null,
      p_hired: next.hired_on || null,
    });
    if (error) return onMsg('存不進去：' + error.message, true);
    const r = data as { ok: boolean; message: string };
    if (!r?.ok) return onMsg(r?.message ?? noRowsMsg('人員設定'), true);
    load();
  }
  async function updW(patch: Record<string, unknown>) {
    const { data, error } = await supabase.from('work_settings')
      .update(patch).eq('id', 1).select('id');
    if (error) return onMsg('存不進去：' + error.message, true);
    if (!data?.length) return onMsg(noRowsMsg('公司預設'), true);
    onMsg('已更新公司預設'); load();
  }

  return (
    <section className="space-y-4">
      {/* 公司預設 */}
      {ws && (
        <div className={`${CARD} p-4`}>
          <div className="text-sm font-medium mb-3">全公司預設</div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {([
              ['work_start', '上班時間', 'time'],
              ['work_end', '下班時間', 'time'],
              ['work_hours_per_day', '每日工時', 'number'],
              ['punch_before_min', '可提前打卡（分）', 'number'],
              ['punch_after_min', '可延後打卡（分）', 'number'],
            ] as const).map(([k, label, type]) => (
              <label key={k} className="text-sm">
                <span className="text-xs text-gray-500 block">{label}</span>
                <input type={type} defaultValue={String(ws[k] ?? '').slice(0, type === 'time' ? 5 : 99)}
                  onBlur={(e) => {
                    const v = type === 'number' ? Number(e.target.value) : e.target.value;
                    if (String(v) !== String(ws[k]).slice(0, type === 'time' ? 5 : 99)) updW({ [k]: v });
                  }}
                  className={INPUT} />
              </label>
            ))}
          </div>
        </div>
      )}

      {/* 個人 */}
      <div className={`${CARD} overflow-hidden`}>
        <div className="px-4 py-2.5 border-b border-mor-line bg-white/45 text-sm font-medium">
          個人設定（留空 = 沿用上面的公司預設）
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-mor-line">
                <th className="px-4 py-2.5">姓名</th>
                <th className="px-4 py-2.5">上班</th>
                <th className="px-4 py-2.5">下班</th>
                <th className="px-4 py-2.5">每日工時</th>
                <th className="px-4 py-2.5">到職日</th>
              </tr>
            </thead>
            <tbody>
              {ppl.filter((p) => p.active).map((p) => (
                <tr key={p.id} className="border-b border-mor-line/60 last:border-0">
                  <td className="px-4 py-2 font-medium whitespace-nowrap">{p.name}</td>
                  {(['work_start', 'work_end'] as const).map((k) => (
                    <td key={k} className="px-4 py-2">
                      <input type="time" defaultValue={(p[k] ?? '').slice(0, 5)}
                        onBlur={(e) => {
                          const v = e.target.value || null;
                          if (v !== (p[k] ?? '').slice(0, 5)) updP(p, { [k]: v } as Partial<Person>);
                        }}
                        className="rounded border border-mor-line px-2 py-1 text-sm" />
                    </td>
                  ))}
                  <td className="px-4 py-2">
                    <input type="number" step="0.5" placeholder="預設"
                      defaultValue={p.work_hours_per_day ?? ''}
                      onBlur={(e) => {
                        const v = e.target.value === '' ? null : Number(e.target.value);
                        if (v !== p.work_hours_per_day) updP(p, { work_hours_per_day: v });
                      }}
                      className="w-20 rounded border border-mor-line px-2 py-1 text-sm tabular-nums" />
                  </td>
                  <td className="px-4 py-2">
                    <input type="date" defaultValue={p.hired_on ?? ''}
                      onBlur={(e) => {
                        const v = e.target.value || null;
                        if (v !== p.hired_on) updP(p, { hired_on: v });
                      }}
                      className="rounded border border-mor-line px-2 py-1 text-sm" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════
 * 3. 假別額度
 * ══════════════════════════════════════════════════════ */

/**
 * 【額度單位是小時，不是天】
 * 半天假、兩小時假是常態，用天當單位就得處理 0.25 天這種東西。
 * 顯示的時候再換算成天給人看（人腦是用天在想的）。
 *
 * 【已用時數不能手改】
 * used_hours 由核可的假單重算（recalc_leave_used）。
 * 開放手改的話，改完下一次核可就被重算蓋掉，而沒有人會知道為什麼。
 */
function QuotaSection({ onMsg }: { onMsg: TabProps['onMsg'] }) {
  const supabase = useMemo(() => createClient(), []);
  const [year, setYear] = useState(new Date().getFullYear());
  const [ppl, setPpl] = useState<Person[]>([]);
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [bals, setBals] = useState<Balance[]>([]);

  const load = useCallback(async () => {
    const [{ data: p }, { data: t }, { data: b }] = await Promise.all([
      supabase.from('profiles').select('id, name, role, active, work_start, work_end, work_hours_per_day, hired_on').order('name'),
      supabase.from('leave_types').select('code, name, has_quota, sort').eq('active', true).order('sort'),
      supabase.from('leave_balances').select('*').eq('year', year),
    ]);
    setPpl((p ?? []) as Person[]);
    setTypes((t ?? []) as LeaveType[]);
    setBals((b ?? []) as Balance[]);
  }, [supabase, year]);
  useEffect(() => { load(); }, [load]);

  const quotaTypes = types.filter((t) => t.has_quota);

  async function setQuota(userId: string, code: string, hours: number) {
    const existing = bals.find((b) => b.user_id === userId && b.type_code === code);
    const q = existing
      ? supabase.from('leave_balances').update({ quota_hours: hours }).eq('id', existing.id)
      : supabase.from('leave_balances')
          .insert({ user_id: userId, year, type_code: code, quota_hours: hours });
    const { data, error } = await q.select('id');
    if (error) return onMsg('存不進去：' + error.message, true);
    if (!data?.length) return onMsg(noRowsMsg('額度'), true);
    load();
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm">年度</span>
        <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))}
          className="w-24 rounded border border-mor-line px-2 py-1 text-sm tabular-nums" />
      </div>

      <div className={`${CARD} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-mor-line">
                <th className="px-4 py-2.5">姓名</th>
                {quotaTypes.map((t) => (
                  <th key={t.code} className="px-4 py-2.5">{t.name}（小時）</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ppl.filter((p) => p.active).map((p) => (
                <tr key={p.id} className="border-b border-mor-line/60 last:border-0">
                  <td className="px-4 py-2 font-medium whitespace-nowrap">
                    {p.name}
                    {!p.hired_on && <span className="ml-2 text-[11px] text-amber-600">未填到職日</span>}
                  </td>
                  {quotaTypes.map((t) => {
                    const b = bals.find((x) => x.user_id === p.id && x.type_code === t.code);
                    return (
                      <td key={t.code} className="px-4 py-2">
                        <input type="number" step="0.5" placeholder="未設定"
                          defaultValue={b?.quota_hours ?? ''}
                          onBlur={(e) => {
                            if (e.target.value === '') return;
                            const v = Number(e.target.value);
                            if (v !== Number(b?.quota_hours ?? NaN)) setQuota(p.id, t.code, v);
                          }}
                          className="w-24 rounded border border-mor-line px-2 py-1 text-sm tabular-nums" />
                        {b && (
                          <div className="text-[11px] text-gray-400 mt-0.5">
                            已用 {b.used_hours}・剩 {Math.max(0, Number(b.quota_hours) - Number(b.used_hours))}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════
 * 4. 出勤表匯出
 * ══════════════════════════════════════════════════════ */

/**
 * 【一人一張分頁，不是全部擠一張】
 * 出勤表是拿去對薪資的，對的時候是一個人一個人對。
 * 混在一張要先篩選，而 Excel 的篩選會被下一個開檔的人清掉。
 *
 * 【工作時數的定義寫在表頭】
 * 「為什麼我加班三小時工時還是 8」是必然會被問的問題。
 * 寫在檔案裡，問的人自己看得到答案。
 */
function ReportSection({ onMsg }: { onMsg: TabProps['onMsg'] }) {
  const supabase = useMemo(() => createClient(), []);
  const [ppl, setPpl] = useState<Person[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const today = twToday();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from('profiles')
      .select('id, name, role, active, work_start, work_end, work_hours_per_day, hired_on')
      .order('name')
      .then(({ data }) => {
        const list = (data ?? []) as Person[];
        setPpl(list);
        setSel(new Set(list.filter((p) => p.active).map((p) => p.id)));
      });
  }, [supabase]);

  async function exportXlsx() {
    if (!sel.size) return onMsg('至少要選一個人。', true);
    if (from > to) return onMsg('起日不能晚於迄日。', true);
    setBusy(true);
    try {
      const wb = XLSX.utils.book_new();
      const used = new Set<string>();
      let anyRow = false;

      for (const p of ppl.filter((x) => sel.has(x.id))) {
        const { data, error } = await supabase.rpc('attendance_report', {
          p_user: p.id, p_from: from, p_to: to,
        });
        if (error) { onMsg(`${p.name} 的出勤表讀取失敗：${error.message}`, true); setBusy(false); return; }

        const rows = (data ?? []) as {
          work_date: string; item: string; in_at: string | null; out_at: string | null;
          work_hours: number; leave_hours: number; ot_hours: number;
          late_min: number | null; early_min: number | null; note: string | null;
        }[];

        const head = ['日期', '星期', '類別', '上班', '下班', '工作時數', '請假時數', '加班時數', '遲到(分)', '早退(分)', '備註'];
        const A: unknown[][] = [
          [`${p.name}　出勤表　${from} ~ ${to}`],
          ['工作時數 = 每日工時 − 當日已核可請假時數（下限 0）。加班時數以核可的申請為準，不是打卡待多久。'],
          head,
        ];
        const dow = ['日', '一', '二', '三', '四', '五', '六'];
        let sumW = 0, sumL = 0, sumO = 0;
        for (const r of rows) {
          const d = new Date(`${r.work_date}T00:00:00+08:00`);
          sumW += Number(r.work_hours) || 0;
          sumL += Number(r.leave_hours) || 0;
          sumO += Number(r.ot_hours) || 0;
          A.push([
            r.work_date, dow[d.getDay()], r.item,
            r.in_at ?? '', r.out_at ?? '',
            Number(r.work_hours) || 0, Number(r.leave_hours) || 0, Number(r.ot_hours) || 0,
            r.late_min ?? '', r.early_min ?? '', r.note ?? '',
          ]);
          anyRow = true;
        }
        A.push(['合計', '', '', '', '', sumW, sumL, sumO, '', '', '']);

        const ws = XLSX.utils.aoa_to_sheet(A);
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: head.length - 1 } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: head.length - 1 } },
        ];
        ws['!cols'] = [{ wch: 12 }, { wch: 5 }, { wch: 12 }, { wch: 7 }, { wch: 7 },
          { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 9 }, { wch: 9 }, { wch: 24 }];
        // 表頭凍住 —— 一個月三十列，捲下去就不知道哪一欄是加班了
        ws['!freeze'] = { xSplit: 0, ySplit: 3 };

        // 分頁名 = 姓名。Excel 分頁名不能超過 31 字、不能重複，也不能有 :\/?*[]
        let nm = p.name.replace(/[:\\/?*[\]]/g, '').slice(0, 28) || '員工';
        let n = 2;
        while (used.has(nm)) { nm = `${nm.slice(0, 26)}_${n++}`; }
        used.add(nm);
        XLSX.utils.book_append_sheet(wb, ws, nm);
      }

      // 一列都沒有就不要產檔 —— 空白檔案會被當成「系統壞了」
      if (!anyRow) {
        onMsg('這個區間沒有任何出勤資料，沒有產生檔案。\n確認一下日期範圍是不是選錯了。', true);
        return;
      }
      XLSX.writeFile(wb, `出勤表_${from}_${to}.xlsx`);
      onMsg(`已匯出 ${sel.size} 個人的出勤表`);
    } finally { setBusy(false); }
  }

  const actives = ppl.filter((p) => p.active);

  return (
    <section className="space-y-3">
      <div className={`${CARD} p-4 space-y-3`}>
        <div className="grid md:grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="text-xs text-gray-500 block">起日</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={INPUT} />
          </label>
          <label className="text-sm">
            <span className="text-xs text-gray-500 block">迄日</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={INPUT} />
          </label>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs text-gray-500">人員</span>
            <button onClick={() => setSel(new Set(actives.map((p) => p.id)))} className={BTN2}>全選</button>
            <button onClick={() => setSel(new Set())} className={BTN2}>全不選</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {actives.map((p) => (
              <label key={p.id} className={`rounded-lg border px-3 py-1.5 text-sm cursor-pointer ${
                sel.has(p.id) ? 'border-mor-slate bg-mor-slate/5 text-mor-slate' : 'border-mor-line'}`}>
                <input type="checkbox" className="mr-1.5" checked={sel.has(p.id)}
                  onChange={(e) => {
                    const s = new Set(sel);
                    if (e.target.checked) s.add(p.id); else s.delete(p.id);
                    setSel(s);
                  }} />
                {p.name}
              </label>
            ))}
          </div>
        </div>

        <button onClick={exportXlsx} disabled={busy} className={BTN}>
          {busy ? '產生中…' : `下載出勤表（${sel.size} 人）`}
        </button>
      </div>
    </section>
  );
}
