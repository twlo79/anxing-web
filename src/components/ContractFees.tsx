'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { CONTRACT_FEE_PRESETS, feeLabel } from '@/lib/fee-types';
import { leaseMonths, feeMonthly, leasePeriods, periodOf, ymShow } from '@/lib/lease';
import { softDelete } from '@/lib/trash';

// 讓既有的 import 路徑不用改：這兩個是純函式，定義在 lib/lease（那裡測得到）
export { leaseMonths, feeMonthly };

/**
 * 契約的固定加費設定。**放在編輯契約的視窗裡**，跟租金填在一起。
 *
 * 【為什麼從收租視窗搬過來】
 * 固定加費是契約的一部分 —— 「這間房每月租金 165,000、管理費 3,000」
 * 是同一件事的兩個數字。原本要先存契約、再打開收租視窗、再展開一個摺疊面板
 * 才填得到，中間隔了三步，於是很多契約的加費根本沒被建起來。
 *
 * 收租視窗改成只顯示明細（唯讀）—— 那裡是「收錢」，不是「設定」。
 *
 * 【三種停止方式，用途完全不同】
 *   暫停    active=false  ——「先不要收了」。未收款的全部拿掉，已收的不動。
 *                            隨時可以恢復，設定還在。
 *   停止收費 end_ym       ——「收到某一期為止」。之後的未收款會消失。
 *   刪除                  ——「當初根本建錯了」。設定連同未收款一起消失，
 *                            事後看不出這筆費用曾經存在過。
 *
 * 房客把冰箱退掉 → 停止收費。這個月先不收 → 暫停。建錯了 → 刪除。
 */

export type Rc = {
  id: string; contract_id: string;
  fee_type: string; item_name: string | null;
  amount: number; start_ym: string; end_ym: string | null;
  active: boolean; note: string | null;
};

const fmt = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('en-US');
/** 'YYYYMM' → '2026-07'。輸入框用 month 型別，值的格式是 YYYY-MM。 */
export const toMonthInput = (ym: string | null) =>
  (ym && /^\d{6}$/.test(ym) ? `${ym.slice(0, 4)}-${ym.slice(4)}` : '');
const fromMonthInput = (v: string) => (/^\d{4}-\d{2}$/.test(v) ? v.replace('-', '') : '');
const ymOf = (d: string | null | undefined) => (d ? `${d.slice(0, 4)}${d.slice(5, 7)}` : '');


export default function ContractFees({
  contract, canEdit, onChanged, onPending,
}: {
  /** id 為空字串 = 新增契約中，還沒有 contract_id 可以掛 */
  contract: { id: string; start_date: string | null; end_date: string | null; cadence: string };
  canEdit: boolean;
  /** 設定變動後通知母層重載期別 —— 費用單是觸發器產生的，畫面要重查才看得到 */
  onChanged?: () => void;
  /**
   * 新增契約時把暫存的設定回報給母層。
   * 契約還沒有 id，加費不可能先寫進資料庫 —— 母層在 insert 成功之後
   * 拿這份清單補寫。不這樣做的話「新增契約」就填不了加費，
   * 而那正是這個元件搬到編輯視窗要解決的問題。
   */
  onPending?: (rows: Rc[]) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const isNew = !contract.id;
  const [rows, setRows] = useState<Rc[]>([]);
  const [counts, setCounts] = useState<Record<string, { n: number; paid: number; paidAmt: number }>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [draft, setDraft] = useState<Rc | null>(null);

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 4000); }

  const load = useCallback(async () => {
    if (isNew) return;                       // 新增中沒有東西可以撈
    const { data } = await supabase.from('contract_recurring_charges')
      .select('*').eq('contract_id', contract.id).order('fee_type').order('item_name');
    const list = (data ?? []) as Rc[];
    setRows(list);

    // 每個設定產生了幾期、其中幾期已收款。刪除前要把這個數字講出來。
    if (list.length) {
      const { data: od } = await supabase.from('orders')
        .select('order_key, amount, paid')
        .eq('imported_via', 'contract_fee').eq('contract_id', contract.id);
      const m: Record<string, { n: number; paid: number; paidAmt: number }> = {};
      for (const o of (od ?? []) as { order_key: string; amount: number; paid: boolean }[]) {
        // 'CRC_' + uuid(36) + '_' + YYYYMM
        const rid = o.order_key.slice(4, 40);
        const s = (m[rid] ??= { n: 0, paid: 0, paidAmt: 0 });
        s.n += 1;
        if (o.paid) { s.paid += 1; s.paidAmt += Number(o.amount) || 0; }
      }
      setCounts(m);
    } else setCounts({});
  }, [supabase, contract.id, isNew]);
  useEffect(() => { load(); }, [load]);

  // 新增模式：每次本地清單變動就回報給母層
  useEffect(() => { if (isNew) onPending?.(rows); /* eslint-disable-next-line */ }, [rows, isNew]);

  function blank(): Rc {
    const p = CONTRACT_FEE_PRESETS[0];
    return {
      id: '', contract_id: contract.id,
      fee_type: p.fee_type, item_name: p.item_name,
      amount: 0,
      // 預設租期第一個月 —— 大部分情況就是整段租期都要收。
      // 取 leaseMonths 的第一項而不是 start_date 的月份:兩者理應相同,
      // 但取同一個來源就不可能出現「預設值不在選項裡」。
      start_ym: leasePeriods(contract.start_date, contract.end_date, contract.cadence)[0]?.ym
        || ymOf(contract.start_date) || ymOf(new Date().toISOString()),
      end_ym: null, active: true, note: null,
    };
  }

  async function save() {
    if (!draft) return;
    if (!(Number(draft.amount) > 0)) return flash('請填金額');
    if (!/^\d{6}$/.test(draft.start_ym)) return flash('請選開始期別');
    if (draft.end_ym && draft.end_ym < draft.start_ym) return flash('結束期別不能早於開始期別');

    // 新增契約中：只存在畫面上，等契約 insert 完再一起寫
    if (isNew) {
      const tmp = { ...draft, id: draft.id || `tmp_${Date.now()}` };
      setRows((rs) => (draft.id ? rs.map((r) => (r.id === draft.id ? tmp : r)) : [...rs, tmp]));
      setDraft(null);
      return flash('已加入，儲存契約時會一起建立');
    }

    setBusy(true);
    const payload = {
      contract_id: contract.id, fee_type: draft.fee_type, item_name: draft.item_name,
      amount: Math.round(Number(draft.amount)), start_ym: draft.start_ym,
      end_ym: draft.end_ym || null, active: draft.active, note: draft.note || null,
    };
    const { error } = draft.id
      ? await supabase.from('contract_recurring_charges').update(payload).eq('id', draft.id)
      : await supabase.from('contract_recurring_charges').insert(payload);
    setBusy(false);
    if (error) return flash('儲存失敗:' + error.message);
    setDraft(null);
    flash('已儲存,各期已更新');
    await load();
    onChanged?.();
  }

  /**
   * 暫停／恢復。
   *
   * 暫停會把**尚未收款**的期別全部拿掉（含過去未收的），已收款的一列不動。
   * 恢復之後會重新長回來 —— 所以它是可逆的，跟「停止收費」不一樣。
   */
  async function toggleActive(r: Rc) {
    if (isNew) {
      setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, active: !x.active } : x)));
      return;
    }
    const s = counts[r.id];
    const unpaid = Math.max(0, (s?.n ?? 0) - (s?.paid ?? 0));
    if (r.active && !confirm(
      `暫停「${feeLabel(r.fee_type, r.item_name)}」?\n\n`
      + `尚未收款的 ${unpaid} 期會被移除（營收認列跟著消失）。\n`
      + (s?.paid ? `已收款的 ${s.paid} 期一律保留 —— 錢收了就是收了。\n` : '')
      + `\n隨時可以按「恢復」把它加回來。`
    )) return;
    setBusy(true);
    const { error } = await supabase.from('contract_recurring_charges')
      .update({ active: !r.active }).eq('id', r.id);
    setBusy(false);
    if (error) return flash('失敗:' + error.message);
    flash(r.active ? '已暫停，未收款的期別已移除' : '已恢復，各期重新產生');
    await load();
    onChanged?.();
  }

  /**
   * 停止收費。**這是「冰箱退掉了」的正確操作。**
   * 設結束期別，不是刪設定 —— 已收款的期別必須留著。
   */
  async function stopAt(r: Rc) {
    const def = toMonthInput(r.end_ym) || new Date().toISOString().slice(0, 7);
    const v = prompt(
      `「${feeLabel(r.fee_type, r.item_name)}」收到哪一期為止?\n\n`
      + `格式 YYYY-MM。填 2026-07 表示收到 2026 年 7 月，8 月起不再產生。\n\n`
      + `之後尚未收款的會自動刪除（營收認列跟著消失），\n`
      + `已經收款的一律保留 —— 錢收了就是收了。`,
      def);
    if (v === null) return;
    const ym = fromMonthInput(v.trim());
    if (!ym) return flash('格式要像 2026-07');
    if (ym < r.start_ym) return flash('結束期別不能早於開始期別');
    if (isNew) {
      setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, end_ym: ym } : x)));
      return;
    }
    setBusy(true);
    const { error } = await supabase.from('contract_recurring_charges')
      .update({ end_ym: ym }).eq('id', r.id);
    setBusy(false);
    if (error) return flash('失敗:' + error.message);
    flash(`已設定收到 ${toMonthInput(ym)} 為止`);
    await load();
    onChanged?.();
  }

  async function del(r: Rc) {
    if (isNew) { setRows((rs) => rs.filter((x) => x.id !== r.id)); return; }
    const s = counts[r.id];
    if (!confirm(
      `刪除設定「${feeLabel(r.fee_type, r.item_name)}」?\n\n`
      + (s?.paid
        ? `⚠ 底下有 ${s.paid} 期已收款（$${fmt(s.paidAmt)}），那些**會留著**。\n`
          + `尚未收款的 ${s.n - s.paid} 期會被刪除。\n\n`
          + `若只是要停止收費，請改按「暫停」或「停止收費」——\n`
          + `刪掉設定之後就看不出這筆費用曾經存在過。\n`
        : `尚未收款的 ${s?.n ?? 0} 期會一併刪除。\n`)
      + `\n會移到回收桶,可以復原。`
    )) return;
    setBusy(true);
    const res = await softDelete(supabase, 'contract_recurring_charges', r.id, '契約固定加費設定刪除');
    setBusy(false);
    if (!res.ok) return flash(res.message);
    flash(res.message);
    await load();
    onChanged?.();
  }

  const presetValue = (r: Rc) =>
    CONTRACT_FEE_PRESETS.findIndex(
      (p) => p.fee_type === r.fee_type && (p.item_name ?? null) === (r.item_name || null));

  const live = feeMonthly(rows);
  /*
   * 期別跟著契約的繳別 —— 年繳約一年一期，不是十二個月。
   * 「管理費 3,000」就是這一期加 3,000；要收 36,000 就填 36,000。
   * （migration_106 之前是每月一張,年繳契約因此多收了 11 個月。）
   */
  const periods = useMemo(
    () => leasePeriods(contract.start_date, contract.end_date, contract.cadence),
    [contract.start_date, contract.end_date, contract.cadence]);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-semibold text-gray-500">
          固定加費<span className="ml-1.5 font-normal text-gray-400">每一期自動加入</span>
        </div>
        <div className="text-xs text-gray-500">
          {rows.length === 0 ? '尚未設定' : <>每期 <b className="text-mor-ink">${fmt(live)}</b></>}
        </div>
      </div>

      {msg && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">{msg}</div>}

      {rows.map((r) => {
        const s = counts[r.id];
        const ended = !!r.end_ym;
        const off = !r.active;
        return (
          <div key={r.id}
            className={`rounded-lg border px-3 py-2 text-sm ${
              off ? 'border-mor-line bg-gray-50 opacity-70' : ended ? 'border-mor-line bg-gray-50' : 'border-mor-line'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="font-medium">{feeLabel(r.fee_type, r.item_name)}</span>
                <span className="ml-2">${fmt(r.amount)}<span className="text-xs text-gray-400"> / 期</span></span>
                {off && <span className="ml-2 text-xs rounded bg-amber-100 text-amber-700 px-1.5 py-0.5">暫停中</span>}
                {ended && <span className="ml-2 text-xs rounded bg-gray-200 text-gray-600 px-1.5 py-0.5">收到 {toMonthInput(r.end_ym)} 為止</span>}
              </div>
              {canEdit && (
                <div className="flex items-center gap-3 text-xs shrink-0">
                  <button onClick={() => setDraft(r)} disabled={busy} className="text-mor-slate underline">編輯</button>
                  <button onClick={() => toggleActive(r)} disabled={busy}
                    className={off ? 'text-mor-green underline' : 'text-amber-600 underline'}>
                    {off ? '恢復' : '暫停'}
                  </button>
                  {!ended && !off && <button onClick={() => stopAt(r)} disabled={busy} className="text-gray-500 underline">停止收費</button>}
                  <button onClick={() => del(r)} disabled={busy} className="text-red-400 hover:text-red-600 underline">刪除</button>
                </div>
              )}
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5">
              {toMonthInput(r.start_ym)} 起
              {s ? `・已產生 ${s.n} 期${s.paid ? `，其中 ${s.paid} 期已收款 $${fmt(s.paidAmt)}` : ''}` : ''}
            </div>
          </div>
        );
      })}

      {draft && (
        <div className="rounded-lg border border-mor-blue bg-mor-bluelight/30 px-3 py-3 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-gray-500">項目</span>
              <select value={presetValue(draft)} className="h-11 md:h-8 rounded-lg border border-mor-line px-2 text-sm bg-white"
                onChange={(e) => {
                  const p = CONTRACT_FEE_PRESETS[Number(e.target.value)];
                  if (p) setDraft({ ...draft, fee_type: p.fee_type, item_name: p.item_name });
                }}>
                {/* 舊資料若不在預設清單裡,要留一個選項,否則一存檔就被改成第一項 */}
                {presetValue(draft) < 0 && <option value={-1}>{feeLabel(draft.fee_type, draft.item_name)}（自訂）</option>}
                {CONTRACT_FEE_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-gray-500">每期金額</span>
              <input type="number" inputMode="numeric" value={draft.amount || ''} placeholder="0"
                onChange={(e) => setDraft({ ...draft, amount: parseFloat(e.target.value) || 0 })}
                className="h-11 md:h-8 rounded-lg border border-mor-line px-2 text-sm text-right bg-white" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-gray-500">開始期別</span>
              <select value={periodOf(periods, draft.start_ym)?.ym ?? draft.start_ym}
                onChange={(e) => setDraft({ ...draft, start_ym: e.target.value })}
                className="h-11 md:h-8 rounded-lg border border-mor-line px-2 text-sm bg-white">
                {/* 舊資料的期別可能落在租期外(租期後來改過) —— 留一個選項,
                    否則一打開編輯就被下拉改成第一期,而且不會有提示 */}
                {!periodOf(periods, draft.start_ym) && (
                  <option value={draft.start_ym}>{ymShow(draft.start_ym)}（不在租期內）</option>
                )}
                {periods.map((p) => <option key={p.ym} value={p.ym}>{p.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-gray-500">結束期別<span className="text-gray-400">（不選＝到租期結束）</span></span>
              <select value={draft.end_ym ? (periodOf(periods, draft.end_ym)?.ym ?? draft.end_ym) : ''}
                onChange={(e) => setDraft({ ...draft, end_ym: e.target.value || null })}
                className="h-11 md:h-8 rounded-lg border border-mor-line px-2 text-sm bg-white">
                <option value="">到租期結束</option>
                {draft.end_ym && !periodOf(periods, draft.end_ym) && (
                  <option value={draft.end_ym}>{ymShow(draft.end_ym)}（不在租期內）</option>
                )}
                {/* 只列開始期別之後的期 —— 選得到更早的期就等於留了一個
                    必定被擋下來的選項,而擋下來的訊息使用者要按了才看得到 */}
                {periods.filter((p) => !draft.start_ym || p.ym >= draft.start_ym)
                  .map((p) => <option key={p.ym} value={p.ym}>{p.label}</option>)}
              </select>
            </label>
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={busy}
              className="flex-1 h-11 md:h-9 rounded-lg bg-mor-slate text-white text-sm font-medium disabled:opacity-40">
              {busy ? '處理中…' : '加入'}
            </button>
            <button onClick={() => setDraft(null)}
              className="flex-1 h-11 md:h-9 rounded-lg border border-gray-300 text-sm">取消</button>
          </div>
        </div>
      )}

      {/* 沒有租期就算不出期別。先講,不然按了新增只會看到一個空的下拉。 */}
      {canEdit && !draft && !periods.length && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          先填「租期起」與「租期迄」，才能設定固定加費的期別。
        </div>
      )}

      {canEdit && !draft && !!periods.length && (
        <button type="button" onClick={() => setDraft(blank())}
          className="w-full h-10 rounded-lg border border-dashed border-mor-line text-xs text-mor-blue hover:bg-mor-sand/30">
          + 新增固定加費
        </button>
      )}

      {isNew && rows.length > 0 && (
        <div className="text-[11px] text-gray-400">儲存契約時會一起建立這 {rows.length} 筆設定。</div>
      )}
    </div>
  );
}
