'use client';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { createClient } from '@/lib/supabase';
import MoneyInput from '@/components/MoneyInput';
import Req from '@/components/Req';
import { savedToast } from '@/lib/saved-feedback';
import {
  depositAvail, settleTotals, quickPicks, settleError, settlePath, PATH_LABEL, PATH_BUTTON,
} from '@/lib/cancel-settle';

/*
 * ══════════════════════════════════════════════════════════
 * 取消訂單・結算退款（migration_319，2026-10-06 David 過審 B 版）
 *
 *   已收（押金＋房費）→ 沒入多少、退還多少 → 退還 0 結案／未滿 3,000 免審／3,000 以上送審
 *
 * ★ 金額怎麼分、走哪條路，真正的規則在資料庫 cancel_order_settle()；這裡只是試算與擋門訊息（lib/cancel-settle.ts）。
 * ★ 沒入與退還兩格都能打，互相連動；超過已收合計時直接講原因（David：「退還不能多於全部金額」）。
 * ══════════════════════════════════════════════════════════
 */

type Ord = { id: string; guest_name: string | null; property_raw: string | null; paid_amount?: number | null; amount: number };
type Dep = { id: string; received_on: string | null; received_amount: number | null; amount: number | null;
             refund_status: string | null; payee_name: string | null; payee_bank_code: string | null; payee_account: string | null };

const money = (n: number) => '$' + Math.round(n).toLocaleString();
const REASONS = ['房客取消', '提前退房', '其他'];

export default function CancelSettleModal({ order, onClose, onDone }: {
  order: Ord; onClose: () => void; onDone: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [dep, setDep] = useState<Dep | null>(null);
  const [fees, setFees] = useState(0);
  const [forfeit, setForfeit] = useState(0);
  const [refund, setRefund] = useState(0);
  const [reason, setReason] = useState(REASONS[0]);
  const [payee, setPayee] = useState({ name: '', bank: '', account: '' });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      const { data: d } = await supabase.from('deposits')
        .select('id, received_on, received_amount, amount, refund_status, payee_name, payee_bank_code, payee_account')
        .eq('order_id', order.id).eq('kind', 'deposit').maybeSingle();
      let f = 0;
      if (d?.id) {
        const { data: fs } = await supabase.from('orders').select('amount').eq('deposit_id', d.id).eq('source', 'oneoff');
        f = (fs ?? []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
      }
      setDep((d as Dep) ?? null); setFees(f);
      setPayee({ name: d?.payee_name ?? '', bank: d?.payee_bank_code ?? '', account: d?.payee_account ?? '' });
      setLoading(false);
    })();
  }, [supabase, order.id]);

  const t = useMemo(() => settleTotals(depositAvail(dep, fees), order.paid_amount), [dep, fees, order.paid_amount]);
  // 預設全部沒入
  useEffect(() => { if (!loading) { setForfeit(t.total); setRefund(0); } }, [loading, t.total]);

  const path = settlePath(refund);
  const showErr = settleError(forfeit, refund, t.total);                       // 金額的錯：一打就講
  const submitErr = settleError(forfeit, refund, t.total, { name: payee.name, account: payee.account });
  const bad = (k: 'name' | 'account') => tried && refund > 0 && !payee[k].trim();

  const go = async () => {
    setTried(true);
    if (submitErr) return setErr(submitErr);
    setBusy(true); setErr('');
    const { data, error } = await supabase.rpc('cancel_order_settle', {
      p_order: order.id, p_forfeit: forfeit, p_reason: reason,
      p_payee_name: refund > 0 ? payee.name : null, p_payee_bank_code: refund > 0 ? payee.bank : null,
      p_payee_account: refund > 0 ? payee.account : null,
    });
    setBusy(false);
    if (error) return setErr('沒結算成功：' + error.message);
    const r = data as { ok: boolean; message: string };
    if (!r?.ok) return setErr(r?.message ?? '沒結算成功');
    savedToast(r.message);
    onDone();
  };

  const tone = path === 'close' ? 'bg-red-50 text-red-700' : path === 'direct' ? 'bg-amber-50 text-amber-800' : 'bg-mor-bluelight text-mor-slate';
  const line = (label: React.ReactNode, v: React.ReactNode, strong = false) => (
    <div className={`flex justify-between py-1 tabular-nums ${strong ? 'font-semibold border-t border-mor-line mt-1 pt-2' : ''}`}>
      <span>{label}</span><span>{v}</span>
    </div>
  );

  const body = (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={busy ? undefined : onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="px-5 py-3.5 border-b border-mor-line flex items-center justify-between">
          <div className="min-w-0">
            <b>取消訂單・結算退款</b>
            <span className="ml-2 text-xs text-gray-400">{order.guest_name ?? '—'}・{order.property_raw ?? ''}</span>
          </div>
          <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-5 py-4 overflow-y-auto text-sm space-y-3">
          {loading ? <div className="py-8 text-center text-gray-400">載入中…</div> : <>
            <div className="flex items-center gap-2"><span className="text-[11px] font-bold tracking-wide text-gray-500">已收</span><i className="flex-1 h-px bg-mor-line" /></div>
            <div>
              {line(<>押金 <span className="text-xs text-gray-400">{dep?.received_on ? `已收${fees ? `（已扣加費 ${money(fees)}）` : ''}` : dep ? '還沒收' : '沒有押金'}</span></>, money(t.deposit))}
              {line(<>房費 <span className="text-xs text-gray-400">訂單 {money(order.amount)}・已收</span></>, money(t.order))}
              {line('已收合計', money(t.total), true)}
            </div>

            <div className="flex items-center gap-2 pt-1"><span className="text-[11px] font-bold tracking-wide text-gray-500">沒入多少、退多少</span><i className="flex-1 h-px bg-mor-line" /></div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-600">沒入</span>
                <MoneyInput value={forfeit} onChange={(n) => { setForfeit(n); setRefund(t.total - n); setErr(''); }}
                  className={`h-10 rounded-lg border px-2 text-right ${showErr && forfeit > t.total ? 'border-red-400 bg-red-50' : 'border-mor-line'}`} /></label>
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-600">退還</span>
                <MoneyInput value={Math.max(0, refund)} onChange={(n) => { setRefund(n); setForfeit(t.total - n); setErr(''); }}
                  className={`h-10 rounded-lg border px-2 text-right ${showErr && refund > t.total ? 'border-red-400 bg-red-50' : 'border-mor-line'}`} /></label>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-gray-400 mr-0.5">快選</span>
              {quickPicks(t).map((q) => (
                <button key={q.label} onClick={() => { setForfeit(q.forfeit); setRefund(t.total - q.forfeit); setErr(''); }}
                  className={`rounded-md border px-2 py-0.5 text-[11px] ${forfeit === q.forfeit && refund === t.total - q.forfeit
                    ? 'border-mor-slate bg-mor-bluelight text-mor-slate' : 'border-mor-line text-mor-slate hover:bg-mor-sand/50'}`}>
                  {q.label}{q.forfeit > 0 ? ` ${money(q.forfeit)}` : ''}
                </button>
              ))}
            </div>
            {/* 金額不對：直接講原因（不等按送出） */}
            {showErr && <div className="text-xs text-red-600">{showErr}</div>}

            <label className="flex flex-col gap-1"><span className="text-xs text-gray-600">原因</span>
              <select value={reason} onChange={(e) => setReason(e.target.value)} className="h-10 rounded-lg border border-mor-line px-2 bg-white">
                {REASONS.map((r) => <option key={r}>{r}</option>)}
              </select></label>

            {refund > 0 && !showErr && (
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1"><span className="flex items-center text-xs text-gray-600">房客戶名<Req /></span>
                  <input value={payee.name} onChange={(e) => setPayee({ ...payee, name: e.target.value })}
                    className={`h-10 rounded-lg border px-2 ${bad('name') ? 'border-red-400 bg-red-50' : 'border-mor-line'}`} /></label>
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-600">銀行代碼</span>
                  <input value={payee.bank} onChange={(e) => setPayee({ ...payee, bank: e.target.value })} placeholder="822"
                    className="h-10 rounded-lg border border-mor-line px-2" /></label>
                <label className="flex flex-col gap-1 col-span-2"><span className="flex items-center text-xs text-gray-600">房客收款帳號<Req /></span>
                  <input value={payee.account} onChange={(e) => setPayee({ ...payee, account: e.target.value })}
                    className={`h-10 rounded-lg border px-2 ${bad('account') ? 'border-red-400 bg-red-50' : 'border-mor-line'}`} /></label>
              </div>
            )}

            {!showErr && t.total > 0 && <div className={`rounded-lg px-3 py-2 text-xs ${tone}`}>{PATH_LABEL[path]}</div>}
            <div className="text-[11px] text-gray-400 leading-relaxed">
              結算後：訂單標「已取消」、房源狀態空出那幾晚；原本的房費不再算營收，沒入的 {money(Math.max(0, forfeit))} 記成「其他收入・取消入住」
              {path === 'review' ? '（核可後才記）' : ''}。
            </div>
            {err && <div className="text-xs text-red-600">{err}</div>}
          </>}
        </div>

        <div className="px-5 py-3 border-t border-mor-line flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="h-9 rounded-lg border border-mor-line px-4 text-sm">取消</button>
          <button onClick={go} disabled={busy || loading || !!showErr} title={showErr ?? undefined}
            className="h-9 rounded-lg bg-mor-slate text-white px-4 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-50">
            {busy ? '處理中⋯' : PATH_BUTTON[path]}</button>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? null : createPortal(body, document.body);
}
