'use client';
/**
 * 暫付分頁 —— 公司付出去、之後要收回來的押金與保證金（migration_196）。
 *
 * ============================================================
 * 【為什麼是獨立的元件而不是塞進 deposits/page.tsx】
 *
 * 那一頁已經 2,300 行，而暫付跟暫收**只有版面像**:
 *
 *   暫收   錢是別人的，退款要走兩票核可（主管＋總經理）
 *   暫付   錢是我們的，收回是錢進來，不需要核可
 *
 * 混在同一個元件裡的話，每一個判斷式都要先問「這是哪一種」——
 * 而那正是 CLAUDE.md 說的「以後每次都要多想一次」。
 *
 * ★ 分頁籤留在 page.tsx（它要算全部四種的筆數），
 *   切到暫付之後**整個內容區**換成這一支:卡片、篩選、表格都是自己的。
 *   使用者 2026-09-01:「點暫付 後卡片換成 暫付的狀態」。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import StatCard, { StatRow, StatGroup, StatTotal } from '@/components/StatCard';
import MoneyInput from '@/components/MoneyInput';
import { useOnce } from '@/lib/once';
import {
  statusOf, STATUS_LABEL, forfeitedOf, statsOf, validateAdvance,
  CATEGORIES, type Advance, type AdvanceStatus,
} from '@/lib/advance';

const fmt = (n: number) => Math.round(Number(n) || 0).toLocaleString('en-US');

/*
 * 狀態的顏色。★ 照站上既有的語意（記在 ToggleInfo）:
 *   琥珀＝還沒定案的錢（錢在外面，等它回來）
 *   綠＝已收（收回來了）
 *   紅＝警示（被扣了，那是真的損失）
 */
const STATUS_CLASS: Record<AdvanceStatus, string> = {
  draft:    'bg-gray-100 text-gray-500',
  paid:     'bg-amber-50 text-amber-700',
  refunded: 'bg-mor-greenlight text-mor-greendark',
  partial:  'bg-red-50 text-red-600',
};

const CAT_CLASS: Record<string, string> = {
  押金:   'bg-mor-bluelight text-mor-slate',
  保證金: 'bg-purple-50 text-purple-700',
};

const CTRL = 'h-11 md:h-9 rounded-lg border border-gray-300 px-2 text-sm bg-white';

type Row = Advance & { id: string; estate_id: string | null; created_at?: string };

const blank = (): Advance => ({
  category: '押金', counterparty: '', usage: '', amount: 0,
  paid_on: '', refunded_on: null, refunded_amount: null, note: '',
});

export default function AdvanceTab({
  estates, onCount,
}: {
  estates: { id: string; name: string }[];
  /** 把筆數回報給頁面，讓分頁籤上的數字對得起來。 */
  onCount?: (n: number) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [statusF, setStatusF] = useState<'all' | AdvanceStatus>('all');
  const [estateF, setEstateF] = useState('');
  const [edit, setEdit] = useState<Advance | null>(null);

  const estateName = useMemo(
    () => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('advance_payments')
      .select('*').order('paid_on', { ascending: false, nullsFirst: true });
    if (error) setMsg('讀取失敗：' + error.message);
    const list = (data ?? []) as Row[];
    setRows(list);
    onCount?.(list.length);
    setLoading(false);
  }, [supabase, onCount]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => rows.filter((r) => {
    if (estateF && r.estate_id !== estateF) return false;
    if (statusF !== 'all' && statusOf(r) !== statusF) return false;
    return true;
  }), [rows, statusF, estateF]);

  /*
   * ★ 統計算在**篩選前**的全部資料上（`rows` 不是 `shown`）——
   *   卡片是總覽，不是當前清單的重複。切到「已退款」之後
   *   「錢還在外面」那個數字還在，才看得出比例。
   *   跟暫收那邊同一條規則（那裡的註解寫著「筆數算在 base 上」）。
   */
  const st = useMemo(() => statsOf(rows), [rows]);

  async function saveInner() {
    if (!edit) return;
    const err = validateAdvance(edit);
    if (err) { setMsg(err); return; }

    const payload = {
      category: edit.category,
      counterparty: edit.counterparty.trim(),
      usage: edit.usage.trim(),
      estate_id: edit.estate_id || null,
      amount: Number(edit.amount),
      /*
       * ★ 空字串要轉成 null。日期欄留空時 input 給的是 ''，
       *   而 `''` 寫進 date 欄位會被 PostgREST 當成錯誤 ——
       *   症狀是「按了儲存沒反應」，因為錯誤訊息在 console 裡。
       */
      paid_on: edit.paid_on || null,
      refunded_on: edit.refunded_on || null,
      refunded_amount: edit.refunded_on ? Number(edit.refunded_amount ?? 0) : null,
      note: edit.note?.trim() || null,
    };

    const q = edit.id
      ? supabase.from('advance_payments').update(payload).eq('id', edit.id).select('id')
      : supabase.from('advance_payments').insert(payload).select('id');
    const { data, error } = await q;
    if (error) { setMsg('存不進去：' + error.message); return; }
    /*
     * ★★ RLS 擋下的 UPDATE 會**回成功而且影響 0 列**（CLAUDE.md 的坑）。
     *   不檢查長度的話，沒有權限的人按儲存會看到「已儲存」而什麼都沒變。
     */
    if (!data || data.length === 0) {
      setMsg('沒有寫入任何資料 —— 可能是權限不足（暫付限會計以上）');
      return;
    }
    setEdit(null);
    setMsg('已儲存');
    await load();
  }
  const [save, saveBusy] = useOnce(saveInner);

  async function delOne(r: Row) {
    if (!confirm(`刪除「${r.counterparty}・${r.usage}」的 ${fmt(r.amount)}？`)) return;
    const { data, error } = await supabase.from('advance_payments')
      .delete().eq('id', r.id).select('id');
    if (error) { setMsg('刪不掉：' + error.message); return; }
    if (!data || data.length === 0) { setMsg('沒有刪掉任何資料 —— 可能是權限不足'); return; }
    await load();
  }

  return (
    <div>
      {msg && (
        <div className="mb-3 rounded-lg border border-mor-line bg-white px-3 py-2 text-sm flex items-center justify-between gap-3">
          <span>{msg}</span>
          <button onClick={() => setMsg(null)} className="text-xs text-gray-400 underline">關閉</button>
        </div>
      )}

      {/*
        ★ 總計回答的是「我們現在有多少錢在別人那裡」——
          跟暫收那句「錢在我們手上」正好相反，所以標籤要講清楚方向。
          只寫「暫付總計」會被讀成「所有暫付加起來」，而它不含已收回的。
      */}
      <StatTotal
        label="暫付款總計"
        value={`NT$ ${fmt(st.paid.amt)}`}
        sub={`${st.paid.n} 筆・錢在別人手上`} />

      <StatGroup label="暫付" tone="slate" />
      <StatRow className="mb-4">
        {([
          { k: 'paid'      as const, title: '已付款', s: st.paid,      sub: '還沒收回' },
          { k: 'refunded'  as const, title: '已退款', s: st.refunded,  sub: '實際收回' },
          { k: 'forfeited' as const, title: '被扣',   s: st.forfeited, sub: '已轉支出' },
        ]).map((t) => (
          <StatCard key={t.k}
            label={t.title}
            value={`NT$ ${fmt(t.s.amt)}`}
            sub={`${t.s.n} 筆・${t.sub}`}
            muted={t.s.n === 0}
            /*
             * ★ 「被扣」點下去篩「部分退」—— 那兩者是同一群列。
             *   分開命名是因為卡片問的是「損失多少」，
             *   而狀態問的是「這一列走到哪了」。
             */
            active={statusF === (t.k === 'forfeited' ? 'partial' : t.k)}
            onClick={() => setStatusF(t.k === 'forfeited' ? 'partial' : t.k)} />
        ))}
      </StatRow>

      <div className="filter-bar rounded-xl glass p-4 mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業</span>
          <select value={estateF} onChange={(e) => setEstateF(e.target.value)} className={CTRL}>
            <option value="">全部</option>
            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">狀態</span>
          <select value={statusF} onChange={(e) => setStatusF(e.target.value as typeof statusF)} className={CTRL}>
            <option value="all">全部</option>
            {(['draft', 'paid', 'refunded', 'partial'] as const).map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select></label>
        <div className="ml-auto">
          <button onClick={() => setEdit(blank())}
            className="h-11 md:h-9 rounded-lg bg-mor-slate text-white px-4 text-ui font-medium hover:bg-mor-slatedark">
            + 新增暫付
          </button>
        </div>
      </div>

      <div className="rounded-xl glass overflow-x-auto mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-mor-line bg-white/45 text-left">
              <th className="px-3 py-2.5">對象</th>
              <th className="px-3 py-2.5">用途</th>
              <th className="px-3 py-2.5">類別</th>
              <th className="px-3 py-2.5 text-right">暫付款</th>
              <th className="px-3 py-2.5">出款日</th>
              <th className="px-3 py-2.5">收回日</th>
              <th className="px-3 py-2.5 text-right">實收回</th>
              <th className="px-3 py-2.5">狀態</th>
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-400">讀取中⋯</td></tr>
            )}
            {!loading && shown.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-400">
                {rows.length === 0
                  ? '還沒有暫付。請款單的項目選「押金」或「保證金」，確認出款後會出現在這裡。'
                  : '這個篩選沒有資料'}
              </td></tr>
            )}
            {!loading && shown.map((r) => {
              const s = statusOf(r);
              const lost = forfeitedOf(r);
              return (
                <tr key={r.id} className="border-b border-mor-line/40 last:border-0">
                  <td className="px-3 py-2.5">{r.counterparty}</td>
                  <td className="px-3 py-2.5">
                    {r.usage}
                    {r.estate_id && (
                      <span className="ml-1 text-xs text-gray-400">{estateName[r.estate_id] ?? ''}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${CAT_CLASS[r.category] ?? ''}`}>
                      {r.category}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmt(r.amount)}</td>
                  <td className="px-3 py-2.5 text-gray-500">{r.paid_on ?? '—'}</td>
                  <td className="px-3 py-2.5 text-gray-500">{r.refunded_on ?? '—'}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {r.refunded_amount == null ? '—' : fmt(r.refunded_amount)}
                    {/* ★ 被扣的金額寫在旁邊 —— 那是這一列唯一真的損失 */}
                    {lost > 0 && <div className="text-xs text-red-500">被扣 {fmt(lost)}</div>}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_CLASS[s]}`}>
                      {STATUS_LABEL[s]}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    <button onClick={() => setEdit(r)} className="text-xs text-mor-blue underline">改</button>
                    <button onClick={() => delOne(r)} className="ml-2 text-xs text-red-500 underline">刪</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {edit && (
        <div className="fixed inset-0 z-40 bg-black/30 flex items-end md:items-center justify-center p-0 md:p-4"
          onClick={() => setEdit(null)}>
          <div className="bg-white rounded-t-2xl md:rounded-2xl w-full md:max-w-lg max-h-[90vh] overflow-y-auto p-4"
            onClick={(e) => e.stopPropagation()}>
            <div className="text-ui font-medium mb-3">{edit.id ? '編輯暫付' : '新增暫付'}</div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">類別</span>
                <select value={edit.category}
                  onChange={(e) => setEdit({ ...edit, category: e.target.value as Advance['category'] })}
                  className={CTRL}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select></label>

              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">對象（錢付給誰）</span>
                <input value={edit.counterparty}
                  onChange={(e) => setEdit({ ...edit, counterparty: e.target.value })}
                  placeholder="王大明／台北市政府" className={CTRL} /></label>

              <label className="flex flex-col gap-1 sm:col-span-2"><span className="text-xs text-gray-500">用途</span>
                <input value={edit.usage}
                  onChange={(e) => setEdit({ ...edit, usage: e.target.value })}
                  placeholder="安幸辦公室租賃／114 年清潔標案" className={CTRL} /></label>

              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業（選填）</span>
                <select value={edit.estate_id ?? ''}
                  onChange={(e) => setEdit({ ...edit, estate_id: e.target.value || null })}
                  className={CTRL}>
                  <option value="">—</option>
                  {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select></label>

              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">暫付款</span>
                <MoneyInput value={edit.amount} onChange={(n) => setEdit({ ...edit, amount: n })}
                  className={`${CTRL} text-right`} /></label>

              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">出款日</span>
                <input type="date" value={edit.paid_on ?? ''}
                  onChange={(e) => setEdit({ ...edit, paid_on: e.target.value })}
                  className={CTRL} /></label>

              <div className="sm:col-span-2 border-t border-mor-line pt-3 mt-1">
                <div className="text-xs text-gray-500 mb-2">收回（還沒收回就留空）</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">收回日</span>
                    <input type="date" value={edit.refunded_on ?? ''}
                      onChange={(e) => setEdit({ ...edit, refunded_on: e.target.value || null })}
                      className={CTRL} /></label>
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">實際收回</span>
                    <MoneyInput value={Number(edit.refunded_amount ?? 0)}
                      onChange={(n) => setEdit({ ...edit, refunded_amount: n })}
                      disabled={!edit.refunded_on}
                      className={`${CTRL} text-right ${edit.refunded_on ? '' : 'bg-gray-100 text-gray-400'}`} /></label>
                </div>
                {/*
                  ★★ 這一句要在**填的當下**看得到，不是存檔被擋才說。
                    全額被扣填 0 是合法的，而沒有這句話的人會以為要留空 ——
                    留空的話那筆押金會永遠躺在「錢還在外面」的清單裡。
                */}
                <div className="text-xs text-gray-400 mt-2 leading-relaxed">
                  全額被扣就填 <b>0</b>，不要留空 —— 留空代表「還沒收回」，那一筆會一直等一個不會來的退款。
                  {Number(edit.refunded_amount ?? 0) < Number(edit.amount) && edit.refunded_on && (
                    <div className="text-red-500 mt-1">
                      差額 {fmt(Number(edit.amount) - Number(edit.refunded_amount ?? 0))} 會轉成一筆支出。
                    </div>
                  )}
                </div>
              </div>

              <label className="flex flex-col gap-1 sm:col-span-2"><span className="text-xs text-gray-500">備註</span>
                <input value={edit.note ?? ''}
                  onChange={(e) => setEdit({ ...edit, note: e.target.value })} className={CTRL} /></label>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setEdit(null)}
                className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={save} disabled={saveBusy}
                className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-50">
                {saveBusy ? '儲存中⋯' : '儲存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
