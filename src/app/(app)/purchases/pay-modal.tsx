'use client';
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import MoneyInput from '@/components/MoneyInput';
import Req from '@/components/Req';
import { todayStr } from '@/lib/period';
import { fmtIntOrBlank as fmt } from '@/lib/fmt';
import {
  PAY_LABEL, PAY_OPTS, needsPayout, needsPlan, dateWord, acctWord, payAccountsForBook,
} from '@/lib/purchase-pay';
import {
  allocatePay, paidFromExpenses, payTotals, payError, partialBlockedReason, payTabBlocked,
  defaultPayTab, itemPayState, type PayTab, type PayRow,
} from '@/lib/partial-pay';

/*
 * ══════════════════════════════════════════════════════════
 * 請款單「付款」彈窗＋付款進度（migration_323，2026-10-07 David 過審 A 版）
 *
 *   原本抽屜底部兩顆：「改付款計畫」「確認付款日」→ 併成一顆「付款」。
 *   彈窗上方三頁：
 *     先排日期   ＝ 原本的改付款計畫（只寫計畫欄位，不產生支出）
 *     部分付款   ＝ 新的：付一部分，照順序分到項目、產生支出（pay_request_part）
 *     付清尚差   ＝ 沒分次付過 → 原本的確認付款日（填付款日，觸發器產生支出）
 *                  分次付過   → pay_request_part 付剩下的，付滿那一刻填付款日
 *
 * ★★ 分錢的規則在資料庫 pay_request_part()；這裡的預覽用 lib/partial-pay.ts 的同一個排法。
 * ★ 錯誤訊息印在彈窗裡（2026-08-19：印在頁面上會被彈窗蓋住）。
 * ══════════════════════════════════════════════════════════
 */

type Item = { id?: string; item_name: string; amount: number | null };
export type PayReq = {
  id: string; req_no: string; book?: string | null;
  payment_method: string | null; payout_account: string | null; planned_transfer_on: string | null;
  advance_category?: string | null; purchased_on: string | null; paid_amount?: number | null;
  purchase_request_items?: Item[] | null;
};
type Acct = { code: string; name: string; method: string; book?: string | null };

const money = (n: number) => '$' + fmt(Math.round(n));
const TAB_LABEL: Record<PayTab, string> = { plan: '先排日期', part: '部分付款', all: '付清尚差' };

/** 部分付款產生的支出 → 每一項付了多少。抽屜與彈窗共用 */
export function usePartialPaid(reqId: string, itemIds: string[], paidAmount: number, tick = 0) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<PayRow[]>([]);
  const [paid, setPaid] = useState<Record<string, number>>({});
  const key = itemIds.join(',');
  useEffect(() => {
    if (!(paidAmount > 0)) { setRows([]); setPaid({}); return; }
    let live = true;
    (async () => {
      const [{ data: ps }, { data: es }] = await Promise.all([
        supabase.from('purchase_payments').select('id, paid_on, amount, payment_method, pay_account')
          .eq('request_id', reqId).order('created_at'),
        supabase.from('expenses').select('source_item_id, amount')
          .in('source_item_id', key ? key.split(',') : ['00000000-0000-0000-0000-000000000000'])
          .not('payment_id', 'is', null),
      ]);
      if (!live) return;
      setRows((ps ?? []).map((p) => ({ ...p, amount: Number(p.amount) || 0 })) as PayRow[]);
      setPaid(paidFromExpenses((es ?? []).map((e) => ({ source_item_id: e.source_item_id, amount: Number(e.amount) || 0 }))));
    })();
    return () => { live = false; };
  }, [supabase, reqId, key, paidAmount, tick]);
  return { rows, paid };
}

/* ══════ 抽屜裡的付款進度：應付／已付／尚差 ＋ 明細 ＋ 撤銷 ══════ */
export function PayProgress({ req, accountName, canUndo, onChanged, onPaid }: {
  req: PayReq; accountName: Record<string, string>; canUndo: boolean;
  onChanged: (msg: string) => void; onPaid?: (paid: Record<string, number>) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const items = (req.purchase_request_items ?? []).filter((i) => i.id).map((i) => ({ id: i.id as string, amount: Number(i.amount) || 0 }));
  const [tick, setTick] = useState(0);
  const { rows, paid } = usePartialPaid(req.id, items.map((i) => i.id), Number(req.paid_amount) || 0, tick);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { onPaid?.(paid); }, [paid, onPaid]);

  if (!(Number(req.paid_amount) > 0)) return null;
  const t = payTotals(items, rows);

  const undo = async (p: PayRow) => {
    if (!confirm(`撤銷 ${p.paid_on} 那筆 ${money(p.amount)}？\n\n它產生的支出會一起刪掉。`)) return;
    setBusy(p.id); setErr('');
    const { data, error } = await supabase.rpc('undo_request_payment', { p_payment: p.id });
    setBusy('');
    const r = data as { ok: boolean; message: string } | null;
    if (error || !r?.ok) return setErr('沒撤銷成功：' + (error?.message ?? r?.message ?? ''));
    setTick((x) => x + 1);
    onChanged(r.message);
  };

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-bold tracking-wide text-gray-500">付款進度</span><i className="flex-1 h-px bg-mor-line" />
      </div>
      <div className="grid grid-cols-3 gap-2 text-sm">
        {([['應付', t.due, ''], ['已付', t.paid, 'text-mor-greendark'], ['尚差', t.left, t.left > 0 ? 'text-amber-700' : '']] as const).map(([k, v, c]) => (
          <div key={k} className="rounded-lg bg-mor-sand/60 px-3 py-2">
            <div className="text-xs text-gray-500">{k}</div>
            <div className={`font-semibold tabular-nums ${c}`}>{money(v)}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-mor-sand overflow-hidden">
        <div className="h-full bg-mor-green" style={{ width: `${t.pct}%` }} />
      </div>
      <div className="mt-2 rounded-lg border border-mor-line divide-y divide-mor-line/40">
        {rows.map((p, k) => (
          <div key={p.id} className="px-3 py-1.5 text-sm flex items-center gap-3 tabular-nums">
            <span className="text-xs text-gray-400 w-5">#{k + 1}</span>
            <span>{p.paid_on}</span>
            <span className="text-xs text-gray-500 flex-1 truncate">
              {PAY_LABEL[p.payment_method ?? ''] ?? p.payment_method ?? ''}・{accountName[p.pay_account ?? ''] ?? p.pay_account ?? '—'}
            </span>
            <span className="font-medium">{money(p.amount)}</span>
            {canUndo && !req.purchased_on && (
              <button onClick={() => undo(p)} disabled={!!busy}
                className="text-xs text-red-400 underline hover:text-red-600 disabled:opacity-50">
                {busy === p.id ? '撤銷中⋯' : '撤銷'}</button>
            )}
          </div>
        ))}
      </div>
      {req.purchased_on && <div className="text-[11px] text-gray-400 mt-1">已付清。要調整請到支出頁改那幾筆支出。</div>}
      {err && <div className="text-xs text-red-600 mt-1">{err}</div>}
    </div>
  );
}

/** 抽屜項目旁邊的小標籤 */
export function ItemPayTag({ amount, paid }: { amount: number; paid: number | undefined }) {
  if (paid === undefined) return null;
  const st = itemPayState(amount, paid);
  if (st === 'paid') return <span className="ml-2 rounded bg-mor-greenlight text-mor-greendark px-1.5 py-0.5 text-[10px] align-middle">已付</span>;
  if (st === 'partial') return <span className="ml-2 rounded bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 text-[10px] align-middle">部分付款 {money(paid)}／{money(amount)}</span>;
  return null;
}

/* ══════ 付款彈窗 ══════ */
export default function PayModal({ req, payAccounts, onClose, onDone }: {
  req: PayReq; payAccounts: Acct[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const items = useMemo(() => (req.purchase_request_items ?? [])
    .filter((i) => i.id).map((i) => ({ id: i.id as string, name: i.item_name, amount: Number(i.amount) || 0 })), [req]);
  const paidSoFar = Number(req.paid_amount) || 0;
  const { rows, paid } = usePartialPaid(req.id, items.map((i) => i.id), paidSoFar);
  const t = payTotals(items, rows.length ? rows : paidSoFar ? [{ amount: paidSoFar }] : []);

  const planned = !!req.planned_transfer_on;
  const [method, setMethod] = useState(req.payment_method ?? '');
  const blockedPay = payTabBlocked({ needPlan: needsPlan(req.payment_method), planned });
  const [tab, setTab] = useState<PayTab>(defaultPayTab({ needPlan: needsPlan(req.payment_method), planned, paid: paidSoFar }));
  const [date, setDate] = useState(tab === 'plan' ? (req.planned_transfer_on ?? todayStr()) : (req.planned_transfer_on ?? todayStr()));
  const [acct, setAcct] = useState(req.payout_account ?? '');
  const [amt, setAmt] = useState(0);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const acctRow = payAccounts.find((a) => a.code === acct);
  const isLend = !!acctRow && (acctRow.book || 'anxing') !== (req.book || 'anxing');
  const partBlocked = partialBlockedReason({ advance_category: req.advance_category, isLend });
  /* 付清尚差：沒分次付過的單走原本那條路（觸發器處理代墊、暫支）—— 所以不受上面那條限制 */
  const allViaRpc = paidSoFar > 0;
  const amount = tab === 'all' ? t.left : amt;
  const preview = tab === 'plan' ? [] : allocatePay(items, paid, Math.min(amount, t.left));
  const needAcct = needsPayout(method);

  const tabBlocked = (k: PayTab): string | null =>
    k === 'plan' ? null
      : blockedPay ?? (k === 'part' ? partBlocked : (allViaRpc ? partBlocked : null));
  const curBlocked = tabBlocked(tab);
  const amtErr = tab === 'plan' ? null : payError(amount, t.left);

  const go = async () => {
    setTried(true); setErr('');
    if (curBlocked) return setErr(curBlocked);
    if (!date) return setErr(tab === 'plan' ? `填預定${dateWord(method)}` : `填${dateWord(method)}`);
    if (needAcct && !acct) return setErr(`選${acctWord(method)}`);
    setBusy(true);
    try {
      if (tab === 'plan') {
        const patch: Record<string, unknown> = { planned_transfer_on: date, payout_account: needAcct ? acct : null };
        if (method !== req.payment_method) patch.payment_method = method;
        const { data, error } = await supabase.from('purchase_requests').update(patch).eq('id', req.id).select('id');
        if (error) return setErr('儲存失敗：' + error.message);
        if (!data?.length) return setErr('沒有改到任何一列 —— 可能是權限，或這張單的狀態變了。請重新整理再試。');
        return onDone(`已排定 ${req.req_no}・預定${dateWord(method)} ${date}`);
      }
      if (amtErr) return setErr(amtErr);
      if (tab === 'all' && !allViaRpc) {
        /* ★ 原本「確認付款日」那條路，一個字都沒變 */
        const patch: Record<string, unknown> = { purchased_on: date };
        if (needAcct) patch.payout_account = acct;
        if (method !== req.payment_method) { patch.payment_method = method; if (!needAcct) patch.payout_account = null; }
        const { data, error } = await supabase.from('purchase_requests').update(patch).eq('id', req.id).select('id');
        if (error) return setErr('儲存失敗：' + error.message);
        if (!data?.length) return setErr('沒有任何一列被更新，通常是權限或這張單的狀態已經變了。請關掉重新整理後再試一次。');
        return onDone(`已付清 ${req.req_no}，費用已連動到支出`);
      }
      const { data, error } = await supabase.rpc('pay_request_part', {
        p_req: req.id, p_amount: amount, p_paid_on: date, p_method: method, p_account: acct || null,
      });
      const r = data as { ok: boolean; message: string } | null;
      if (error) return setErr('沒付款成功：' + error.message);
      if (!r?.ok) return setErr(r?.message ?? '沒付款成功');
      onDone(`${req.req_no}：${r.message}`);
    } finally { setBusy(false); }
  };

  const nameOf = (id: string) => items.find((i) => i.id === id)?.name ?? '';
  const sel = 'h-10 w-full rounded-lg border px-2 bg-white';
  const bad = (b: boolean) => (tried && b ? 'border-red-400 bg-red-50' : 'border-mor-line');

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="absolute inset-0" onClick={busy ? undefined : onClose} />
      <div className="relative bg-white rounded-xl w-[460px] max-w-full max-h-[90vh] shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-mor-line px-5 py-3.5 flex items-center justify-between">
          <div><b>付款</b><span className="ml-2 text-xs text-gray-400">{req.req_no}</span></div>
          <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-5 py-4 overflow-y-auto text-sm space-y-3">
          <div className="flex gap-1 rounded-lg bg-mor-sand/60 p-1">
            {(['plan', 'part', 'all'] as PayTab[]).map((k) => (
              <button key={k} onClick={() => { setTab(k); setErr(''); setTried(false); }}
                className={`flex-1 rounded-md py-1.5 text-sm ${tab === k ? 'bg-white shadow-sm font-medium text-mor-ink' : 'text-gray-500'}`}>
                {TAB_LABEL[k]}</button>
            ))}
          </div>

          <div className="flex justify-between text-xs text-gray-500 tabular-nums">
            <span>應付 {money(t.due)}</span>
            <span>已付 <span className="text-mor-greendark">{money(t.paid)}</span></span>
            <span>尚差 <span className="text-amber-700">{money(t.left)}</span></span>
          </div>

          {curBlocked ? (
            <div className="rounded-lg bg-amber-50 text-amber-800 px-3 py-2 text-xs">{curBlocked}</div>
          ) : (<>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="flex items-center text-xs text-gray-600">{tab === 'plan' ? `預定${dateWord(method)}` : dateWord(method)}<Req /></span>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${sel} ${bad(!date)}`} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="flex items-center text-xs text-gray-600">{tab === 'plan' ? '預定金額' : '實付金額'}{tab === 'part' && <Req />}</span>
                {tab === 'part'
                  ? <MoneyInput value={amt} onChange={(v) => { setAmt(v); setErr(''); }}
                      className={`h-10 rounded-lg border px-2 text-right ${(tried || amt > t.left) && amtErr ? 'border-red-400 bg-red-50' : 'border-mor-line'}`} />
                  : <div className="h-10 rounded-lg border border-mor-line bg-mor-bg px-2 flex items-center justify-end tabular-nums">{money(t.left)}</div>}
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-600">付款方式</span>
                <select value={method} onChange={(e) => { setMethod(e.target.value); setAcct(''); }} className={`${sel} border-mor-line`}>
                  {PAY_OPTS.map((m) => <option key={m} value={m}>{PAY_LABEL[m] ?? m}</option>)}
                </select>
              </label>
              {needAcct && (
                <label className="flex flex-col gap-1">
                  <span className="flex items-center text-xs text-gray-600">{acctWord(method)}<Req /></span>
                  <select value={acct} onChange={(e) => { setAcct(e.target.value); setErr(''); }} className={`${sel} ${bad(!acct)}`}>
                    <option value="">請選擇</option>
                    {payAccountsForBook(payAccounts, method, req.book, true).map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                  </select>
                </label>
              )}
            </div>
            {method !== req.payment_method && (
              <div className="text-[11px] text-mor-slate">付款方式會從「{PAY_LABEL[req.payment_method ?? ''] ?? '—'}」改成「{PAY_LABEL[method] ?? method}」</div>
            )}

            {tab === 'plan' && <div className="text-[11px] text-gray-400">只排日期，不會產生支出。實際付了再到「部分付款」或「付清尚差」記。</div>}

            {tab !== 'plan' && (amtErr && amount > 0
              ? <div className="text-xs text-red-600">{amtErr}</div>
              : preview.length > 0 && (
                <div>
                  <div className="text-xs text-gray-500 mb-1">這筆會變成支出（先接著扣部分付款的那項，再從金額最小的開始）</div>
                  <div className="rounded-lg border border-mor-line divide-y divide-mor-line/40">
                    {preview.map((a) => (
                      <div key={a.id} className="px-3 py-1.5 flex items-center justify-between gap-2 text-sm">
                        <span className="truncate">{nameOf(a.id)}
                          {a.before > 0 && <span className="text-xs text-gray-400 ml-1">原本已付 {money(a.before)}</span>}</span>
                        <span className="flex items-center gap-2 shrink-0 tabular-nums">
                          {a.done
                            ? <span className="rounded bg-mor-greenlight text-mor-greendark px-1.5 py-0.5 text-[10px]">付清</span>
                            : <span className="rounded bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 text-[10px]">部分付款 {money(a.after)}／{money(a.amount)}</span>}
                          <b className="font-medium">+{money(a.give)}</b>
                        </span>
                      </div>
                    ))}
                  </div>
                  {tab === 'all' && !allViaRpc && (
                    <div className="text-[11px] text-gray-400 mt-1">付清後這張單就不能再撤銷。</div>
                  )}
                </div>
              ))}
          </>)}
          {err && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 whitespace-pre-wrap">{err}</div>}
        </div>

        <div className="border-t border-mor-line px-5 py-3 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="h-9 rounded-lg border border-gray-300 px-4 text-sm">取消</button>
          <button onClick={go} disabled={busy || !!curBlocked || (tab !== 'plan' && !!amtErr && amount > 0)}
            title={curBlocked ?? undefined}
            className="h-9 rounded-lg bg-mor-slate text-white px-4 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-50">
            {busy ? '處理中⋯' : tab === 'plan' ? '儲存' : tab === 'part' ? '記這筆付款' : '付清'}</button>
        </div>
      </div>
    </div>
  );
}
