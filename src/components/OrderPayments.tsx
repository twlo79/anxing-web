'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import {
  payStatus, remaining, isExempt, checkPayment, STATUS_LABEL, STATUS_CLASS,
  type PaymentRow,
} from '@/lib/order-payment';

/**
 * 短租訂單的收款視窗。
 *
 * 【為什麼是一筆一列，不是一個勾】
 * 短租常常分次收（訂金 → 尾款）。只有布林的話「收了訂金」跟「完全沒收」
 * 在畫面上一模一樣，催款的人分不出來。
 *
 * 合計與狀態由資料庫的觸發器維護（migration_84），這裡只負責新增與刪除。
 * **前端不自己算 paid_amount 寫回 orders** —— 兩邊各算一次就會有對不上的一天。
 *
 * 【為什麼刪除而不是編輯】
 * 收款記錯了就把那一列刪掉重記。可編輯的話要處理「改金額後合計要重算」、
 * 「改日期後 paid_at 要重算」，而那些觸發器本來就會做 —— 但多一條路就多一種錯法。
 * 一筆收款是一個事實，錯了就是記錯了，刪掉重來語意最清楚。
 */

type Order = {
  id: string; source: string; amount: number | null;
  paid_amount?: number | null; guest_name?: string | null;
};

const fmt = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('en-US');
const today = () => new Date().toISOString().slice(0, 10);

export default function OrderPayments({
  order, accounts, canEdit, onClose, onChanged,
}: {
  order: Order;
  accounts: { code: string; name: string }[];
  canEdit: boolean;
  onClose: () => void;
  /** 收款有變動時通知母頁重新載入 —— 列表上的狀態標籤要跟著變 */
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // 合計以資料庫回來的為準,不用前端的 rows 加總 —— 兩邊算法不一致時要看得出來
  const [paidAmount, setPaidAmount] = useState(Number(order.paid_amount) || 0);

  const [draftOn, setDraftOn] = useState(today());
  const [draftAmt, setDraftAmt] = useState('');
  const [draftAcct, setDraftAcct] = useState('');
  const [draftNote, setDraftNote] = useState('');

  const due = Math.round(Number(order.amount) || 0);
  const cur = { source: order.source, amount: order.amount, paid_amount: paidAmount };
  const rest = remaining(cur);
  const status = payStatus(cur);

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 3500); }

  const load = useCallback(async () => {
    const [{ data: ps }, { data: od }] = await Promise.all([
      supabase.from('order_payments')
        .select('id, paid_on, amount, account, note')
        .eq('order_id', order.id).order('paid_on').order('created_at'),
      supabase.from('orders').select('paid_amount').eq('id', order.id).single(),
    ]);
    setRows((ps ?? []) as PaymentRow[]);
    setPaidAmount(Number(od?.paid_amount) || 0);
    setLoading(false);
  }, [supabase, order.id]);
  useEffect(() => { load(); }, [load]);

  // 尚欠金額當預設 —— 大部分情況是一次收清，少打幾個字。
  // 已經收滿就留空，避免手滑直接送出一筆重複的。
  useEffect(() => { if (!loading) setDraftAmt(rest > 0 ? String(rest) : ''); }, [loading, rest]);

  async function add() {
    const amt = Number(draftAmt);
    const chk = checkPayment(amt, rest, due);
    if (!chk.ok) return flash(chk.error);
    if (chk.confirm && !confirm(chk.confirm)) return;
    if (!draftOn) return flash('請選收款日');

    setBusy(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('order_payments').insert({
      order_id: order.id, paid_on: draftOn, amount: Math.round(amt),
      account: draftAcct || null, note: draftNote.trim() || null,
      created_by: user?.id ?? null,
    });
    setBusy(false);
    if (error) return flash('存不進去:' + error.message);
    setDraftNote('');
    await load();
    onChanged();
  }

  async function del(r: PaymentRow) {
    if (!confirm(`刪除這筆收款?\n\n${r.paid_on}　$${fmt(r.amount)}\n\n合計與收款狀態會跟著重算。`)) return;
    setBusy(true);
    const { error } = await supabase.from('order_payments').delete().eq('id', r.id);
    setBusy(false);
    if (error) return flash('刪除失敗:' + error.message);
    await load();
    onChanged();
  }

  const acctName = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.code, a.name])), [accounts]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div onClick={(e) => e.stopPropagation()}
        className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">

        <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 flex items-start justify-between">
          <div className="min-w-0">
            <div className="font-bold">收款</div>
            <div className="text-xs text-gray-500 mt-0.5 truncate">{order.guest_name ?? '—'}</div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {msg && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">{msg}</div>}

          {isExempt(order.source) ? (
            <div className="rounded-lg bg-gray-50 border border-mor-line px-3 py-3 text-sm text-gray-500">
              這個來源是平台代收，不需要記收款。
            </div>
          ) : (
            <>
              {/* 三個數字擺在最上面 —— 打開視窗第一眼要回答的就是「還差多少」 */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-mor-sand/60 py-2">
                  <div className="text-[11px] text-gray-500">應收</div>
                  <div className="font-bold">${fmt(due)}</div>
                </div>
                <div className="rounded-lg bg-mor-greenlight py-2">
                  <div className="text-[11px] text-mor-green">已收</div>
                  <div className="font-bold text-mor-green">${fmt(paidAmount)}</div>
                </div>
                <div className={`rounded-lg py-2 ${rest > 0 ? 'bg-red-50' : 'bg-gray-100'}`}>
                  <div className={`text-[11px] ${rest > 0 ? 'text-red-600' : 'text-gray-400'}`}>尚欠</div>
                  <div className={`font-bold ${rest > 0 ? 'text-red-600' : 'text-gray-400'}`}>${fmt(rest)}</div>
                </div>
              </div>
              <div className="text-center">
                <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status]}`}>
                  {STATUS_LABEL[status]}
                </span>
                {paidAmount > due && due > 0 && (
                  <span className="ml-2 text-xs text-amber-600">超收 ${fmt(paidAmount - due)}</span>
                )}
              </div>

              {/* 已收明細 */}
              <div>
                <div className="text-xs text-gray-500 mb-1.5">收款明細</div>
                {loading ? (
                  <div className="text-sm text-gray-400 py-3 text-center">載入中…</div>
                ) : rows.length === 0 ? (
                  <div className="text-sm text-gray-400 py-3 text-center border border-dashed border-mor-line rounded-lg">
                    尚未有收款紀錄
                  </div>
                ) : (
                  <div className="border border-mor-line rounded-lg divide-y divide-mor-line/60">
                    {rows.map((r) => (
                      <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <div className="w-24 shrink-0 text-gray-600">{r.paid_on}</div>
                        <div className="w-24 shrink-0 text-right font-medium">${fmt(r.amount)}</div>
                        <div className="flex-1 min-w-0 text-xs text-gray-500 truncate">
                          {r.account ? (acctName[r.account] ?? r.account) : '—'}
                          {r.note ? `・${r.note}` : ''}
                        </div>
                        {canEdit && (
                          <button onClick={() => del(r)} disabled={busy}
                            className="shrink-0 text-xs text-red-400 underline hover:text-red-600 disabled:opacity-40">刪除</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 新增一筆。收滿之後仍然開著 —— 超收要問一聲,但不擋。 */}
              {canEdit && (
                <div className="rounded-lg border border-mor-line p-3 space-y-2">
                  <div className="text-xs text-gray-500">新增收款</div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-gray-400">收款日</span>
                      <input type="date" value={draftOn} onChange={(e) => setDraftOn(e.target.value)}
                        className="h-11 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 text-sm" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-gray-400">金額（台幣）</span>
                      <input type="number" inputMode="numeric" min={0}
                        value={draftAmt} onChange={(e) => setDraftAmt(e.target.value)}
                        placeholder="0"
                        className="h-11 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 text-sm text-right" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-gray-400">收款帳號</span>
                      <select value={draftAcct} onChange={(e) => setDraftAcct(e.target.value)}
                        className="h-11 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 text-sm">
                        <option value="">未指定</option>
                        {accounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-gray-400">備註（選填）</span>
                      <input value={draftNote} onChange={(e) => setDraftNote(e.target.value)}
                        className="h-11 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 text-sm" />
                    </label>
                  </div>
                  <button onClick={add} disabled={busy}
                    className="w-full h-11 rounded-lg bg-mor-green text-white text-sm font-medium hover:opacity-90 disabled:opacity-40">
                    {busy ? '處理中…' : '確認收款'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          <button onClick={onClose}
            className="w-full h-11 rounded-lg border border-gray-300 text-sm font-medium hover:bg-mor-sand/50">關閉</button>
        </div>
      </div>
    </div>
  );
}
