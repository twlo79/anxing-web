'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { CONTRACT_FEE_PRESETS, feeLabel } from '@/lib/fee-types';

/**
 * 契約的固定加費設定。嵌在收租視窗最上面。
 *
 * 【解決什麼】
 * 管理費、停車費、冰箱租金每一期都會發生。以前只能在每一期手動按「+ 加費」——
 * 年繳的契約要按 4 次，月繳的要按 24 次，而且漏掉某一期不會有任何跡象。
 *
 * 設定一次，租期內每一期自動長出一筆，跟著租金一起收，也一起認列營收。
 *
 * 【停止收費用「結束期別」，不要用刪除】
 * 房客把冰箱退掉了 → 結束期別設成最後一期。系統會把之後**未收款**的
 * 費用單自動刪掉（連同它的營收認列），**已收款的一列都不動**。
 *
 * 刪除設定是給「根本建錯了」用的。它會把未收款的費用單一起清掉，
 * 所以底下有已收款時會先把數字講出來 —— 跟契約刪除的處理一致。
 */

type Rc = {
  id: string; contract_id: string;
  fee_type: string; item_name: string | null;
  amount: number; start_ym: string; end_ym: string | null;
  active: boolean; note: string | null;
};

const fmt = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('en-US');
/** 'YYYYMM' → '2026-07'。輸入框用 month 型別，值的格式是 YYYY-MM。 */
const toMonthInput = (ym: string | null) => (ym && /^\d{6}$/.test(ym) ? `${ym.slice(0, 4)}-${ym.slice(4)}` : '');
const fromMonthInput = (v: string) => (/^\d{4}-\d{2}$/.test(v) ? v.replace('-', '') : '');
const ymOf = (d: string | null | undefined) => (d ? `${d.slice(0, 4)}${d.slice(5, 7)}` : '');

export default function ContractFees({
  contract, canEdit, onChanged,
}: {
  contract: { id: string; start_date: string | null; end_date: string | null };
  canEdit: boolean;
  /** 設定變動後通知母層重載期別 —— 費用單是觸發器產生的，畫面要重查才看得到 */
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Rc[]>([]);
  const [counts, setCounts] = useState<Record<string, { n: number; paid: number; paidAmt: number }>>({});
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [draft, setDraft] = useState<Rc | null>(null);

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 4000); }

  const load = useCallback(async () => {
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
  }, [supabase, contract.id]);
  useEffect(() => { load(); }, [load]);

  function blank(): Rc {
    const p = CONTRACT_FEE_PRESETS[0];
    return {
      id: '', contract_id: contract.id,
      fee_type: p.fee_type, item_name: p.item_name,
      amount: 0,
      // 預設從租期第一個月起 —— 大部分情況就是整段租期都要收
      start_ym: ymOf(contract.start_date) || ymOf(new Date().toISOString()),
      end_ym: null, active: true, note: null,
    };
  }

  async function save() {
    if (!draft) return;
    if (!(Number(draft.amount) > 0)) return flash('請填金額');
    if (!/^\d{6}$/.test(draft.start_ym)) return flash('請選開始期別');
    if (draft.end_ym && draft.end_ym < draft.start_ym) return flash('結束期別不能早於開始期別');
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
    onChanged();
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
    setBusy(true);
    const { error } = await supabase.from('contract_recurring_charges')
      .update({ end_ym: ym }).eq('id', r.id);
    setBusy(false);
    if (error) return flash('失敗:' + error.message);
    flash(`已設定收到 ${toMonthInput(ym)} 為止`);
    await load();
    onChanged();
  }

  async function del(r: Rc) {
    const s = counts[r.id];
    if (!confirm(
      `刪除設定「${feeLabel(r.fee_type, r.item_name)}」?\n\n`
      + (s?.paid
        ? `⚠ 底下有 ${s.paid} 期已收款（$${fmt(s.paidAmt)}），那些**會留著**。\n`
          + `尚未收款的 ${s.n - s.paid} 期會被刪除。\n\n`
          + `若只是要停止收費，請關掉這個視窗改按「停止收費」——\n`
          + `刪掉設定之後就看不出這筆費用曾經存在過。\n`
        : `尚未收款的 ${s?.n ?? 0} 期會一併刪除。\n`)
    )) return;
    setBusy(true);
    const { error } = await supabase.from('contract_recurring_charges').delete().eq('id', r.id);
    setBusy(false);
    if (error) return flash('刪除失敗:' + error.message);
    flash('已刪除');
    await load();
    onChanged();
  }

  const presetValue = (r: Rc) =>
    CONTRACT_FEE_PRESETS.findIndex(
      (p) => p.fee_type === r.fee_type && (p.item_name ?? null) === (r.item_name || null));

  return (
    <div className="mb-4 rounded-xl border border-mor-line overflow-hidden">
      <button onClick={() => setOpen(!open)}
        className="w-full px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-left hover:bg-mor-sand/30">
        <span className="text-sm font-medium">
          <span className="text-gray-400 mr-1">{open ? '▾' : '▸'}</span>
          固定加費
          <span className="ml-2 text-xs font-normal text-gray-500">每一期自動加入（管理費、停車費、設備費…）</span>
        </span>
        <span className="text-xs text-gray-500">
          {rows.length === 0 ? '尚未設定'
            : `${rows.length} 項・每期 $${fmt(rows.filter((r) => r.active).reduce((a, r) => a + Number(r.amount || 0), 0))}`}
        </span>
      </button>

      {open && (
        <div className="border-t border-mor-line px-4 py-3 space-y-2">
          {msg && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">{msg}</div>}

          {rows.length === 0 && !draft && (
            <div className="text-xs text-gray-400 py-2">
              尚未設定。設定之後，租期內每一期都會自動加入這筆費用，跟租金一起收，也一起認列營收。
            </div>
          )}

          {rows.map((r) => {
            const s = counts[r.id];
            const ended = !!r.end_ym;
            return (
              <div key={r.id} className={`rounded-lg border px-3 py-2 text-sm ${ended ? 'border-mor-line bg-gray-50' : 'border-mor-line'}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{feeLabel(r.fee_type, r.item_name)}</span>
                    <span className="ml-2">${fmt(r.amount)}<span className="text-xs text-gray-400"> / 期</span></span>
                    {ended && <span className="ml-2 text-xs rounded bg-gray-200 text-gray-600 px-1.5 py-0.5">收到 {toMonthInput(r.end_ym)} 為止</span>}
                  </div>
                  {canEdit && (
                    <div className="flex items-center gap-3 text-xs shrink-0">
                      <button onClick={() => setDraft(r)} disabled={busy} className="text-mor-slate underline">編輯</button>
                      {!ended && <button onClick={() => stopAt(r)} disabled={busy} className="text-amber-600 underline">停止收費</button>}
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
                  <input type="month" value={toMonthInput(draft.start_ym)}
                    onChange={(e) => setDraft({ ...draft, start_ym: fromMonthInput(e.target.value) })}
                    className="h-11 md:h-8 rounded-lg border border-mor-line px-2 text-sm bg-white" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-gray-500">結束期別<span className="text-gray-400">（不填＝到租期結束）</span></span>
                  <input type="month" value={toMonthInput(draft.end_ym)}
                    onChange={(e) => setDraft({ ...draft, end_ym: fromMonthInput(e.target.value) || null })}
                    className="h-11 md:h-8 rounded-lg border border-mor-line px-2 text-sm bg-white" />
                </label>
              </div>
              <div className="text-[11px] text-gray-500">
                產生範圍會夾在租期內。之後改租期或改期別時，**尚未收款的**會自動跟著調整，已收款的不動。
              </div>
              <div className="flex gap-2">
                <button onClick={save} disabled={busy}
                  className="flex-1 h-11 md:h-9 rounded-lg bg-mor-slate text-white text-sm font-medium disabled:opacity-40">
                  {busy ? '處理中…' : '儲存'}
                </button>
                <button onClick={() => setDraft(null)}
                  className="flex-1 h-11 md:h-9 rounded-lg border border-gray-300 text-sm">取消</button>
              </div>
            </div>
          )}

          {canEdit && !draft && (
            <button onClick={() => setDraft(blank())}
              className="w-full h-10 rounded-lg border border-dashed border-mor-line text-xs text-mor-blue hover:bg-mor-sand/30">
              + 新增固定加費
            </button>
          )}
        </div>
      )}
    </div>
  );
}
