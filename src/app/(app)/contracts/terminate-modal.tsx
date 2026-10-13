'use client';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { createClient } from '@/lib/supabase';
import MoneyInput from '@/components/MoneyInput';
import RefundFields, { type RefundDraft, type RefundPayAccount } from '@/components/RefundFields';
import { savedToast } from '@/lib/saved-feedback';
import {
  earnedTo, livedText, termTotals, depositAvailable, refundOf, termPicks, termError, settlePath,
  TERM_PATH_LABEL, TERM_PATH_BUTTON, type Split,
} from '@/lib/contract-terminate';

/*
 * ══════════════════════════════════════════════════════════
 * 提前終止契約・結算退款（migration_331，2026-10-13 David 過審）
 *
 *   照「取消訂單・結算退款」的樣子：
 *   ① 終止日　② 已收、已住、可以結算的　③ 沒收多少、退多少（預收租金／押金兩列）　④ 退還怎麼退
 *
 * ★ 真正的規則在資料庫 terminate_contract_settle()；這裡是試算與擋門訊息（lib/contract-terminate.ts）。
 * ★ 「結束租約」拿掉了（David：「如果是這樣不需要結束租吧」）——
 *   到期什麼都不用按；提前結束、沒有錢要結的，在這裡沒收／退還都是 0，按下去就結案。
 * ══════════════════════════════════════════════════════════
 */

export type TermContract = {
  id: string; room: string | null; tenant_name: string | null;
  start_date: string | null; end_date: string | null; monthly_rent: number | null;
};
type Dep = {
  id: string; received_on: string | null; received_amount: number | null; amount: number | null;
  returned_on: string | null; forfeited_on: string | null; refund_status: string | null;
  payee_name: string | null; payee_bank_code: string | null; payee_account: string | null;
  planned_refund_on: string | null; returned_method: string | null; returned_account: string | null;
};

const money = (n: number) => '$' + Math.round(n).toLocaleString();
const REASONS = ['房客提前退租', '房客違約', '雙方協議解約', '其他'];
const todayTw = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

export default function TerminateModal({ c, onClose, onDone }: {
  c: TermContract; onClose: () => void; onDone: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [rentPaid, setRentPaid] = useState(0);
  const [dep, setDep] = useState<Dep | null>(null);
  const [fees, setFees] = useState(0);
  const [payAccounts, setPayAccounts] = useState<RefundPayAccount[]>([]);
  const [end, setEnd] = useState(() => {
    const t = todayTw();
    return c.end_date && t > c.end_date ? c.end_date : t;
  });
  const [split, setSplit] = useState<Split>({ rentForfeit: 0, depForfeit: 0 });
  const [reason, setReason] = useState(REASONS[0]);
  const [rf, setRf] = useState<RefundDraft>({});
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      const [{ data: os }, { data: d }, { data: pa }] = await Promise.all([
        supabase.from('orders').select('paid_amount').eq('contract_id', c.id).eq('imported_via', 'contract'),
        supabase.from('deposits')
          .select('id, received_on, received_amount, amount, returned_on, forfeited_on, refund_status, payee_name, payee_bank_code, payee_account, planned_refund_on, returned_method, returned_account')
          .eq('contract_id', c.id).eq('kind', 'deposit').order('created_at').limit(1).maybeSingle(),
        supabase.from('payment_accounts').select('code, name, method').eq('active', true).order('sort'),
      ]);
      setRentPaid(((os ?? []) as { paid_amount: number | null }[]).reduce((s, x) => s + (Number(x.paid_amount) || 0), 0));
      let f = 0;
      if (d?.id) {
        const { data: fs } = await supabase.from('orders').select('amount').eq('deposit_id', d.id).eq('source', 'oneoff');
        f = (fs ?? []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
      }
      setDep((d as Dep) ?? null); setFees(f);
      setPayAccounts((pa ?? []) as RefundPayAccount[]);
      setRf({ payee_name: d?.payee_name || c.tenant_name || '', payee_bank_code: d?.payee_bank_code ?? '', payee_account: d?.payee_account ?? '',
              planned_refund_on: d?.planned_refund_on ?? null, returned_method: d?.returned_method ?? null, returned_account: d?.returned_account ?? null });
      setLoading(false);
    })();
  }, [supabase, c.id, c.tenant_name]);

  const earned = useMemo(() => earnedTo(c, end), [c, end]);
  const t = useMemo(() => termTotals(rentPaid, earned, depositAvailable(dep, fees)), [rentPaid, earned, dep, fees]);
  // 預設全退（提前退租多半要退）；換終止日時重設
  useEffect(() => { if (!loading) setSplit({ rentForfeit: 0, depForfeit: 0 }); }, [loading, t.prepaid, t.deposit]);

  const r = refundOf(t, split);
  const path = settlePath(r.total);
  const showErr = termError(c, end, t, split);
  const submitErr = termError(c, end, t, split, { name: rf.payee_name ?? '', account: rf.payee_account ?? '' });
  const rfMissing = tried && r.total > 0
    ? [!rf.payee_name?.trim() && '戶名', !rf.payee_account?.trim() && '房客收款帳號'].filter(Boolean) as string[] : [];

  const go = async () => {
    setTried(true);
    if (submitErr) return setErr(submitErr);
    setBusy(true); setErr('');
    const pay = r.total > 0;
    const { data, error } = await supabase.rpc('terminate_contract_settle', {
      p_contract: c.id, p_end: end, p_rent_forfeit: split.rentForfeit, p_dep_forfeit: split.depForfeit, p_reason: reason,
      p_payee_name: pay ? rf.payee_name : null, p_payee_bank_code: pay ? rf.payee_bank_code : null,
      p_payee_account: pay ? rf.payee_account : null,
      p_planned_on: pay ? (rf.planned_refund_on || null) : null,
      p_returned_method: pay ? (rf.returned_method || null) : null,
      p_returned_account: pay ? (rf.returned_account || null) : null,
    });
    setBusy(false);
    if (error) return setErr('沒結算成功：' + error.message + (error.message.includes('terminate_contract_settle') ? '（migration_331 跑了嗎？）' : ''));
    const res = data as { ok: boolean; message: string };
    if (!res?.ok) return setErr(res?.message ?? '沒結算成功');
    savedToast(res.message);
    onDone();
  };

  const tone = path === 'close' ? 'bg-red-50 text-red-700' : path === 'direct' ? 'bg-amber-50 text-amber-800' : 'bg-mor-bluelight text-mor-slate';
  const sec = (s: string) => (
    <div className="flex items-center gap-2 pt-1"><span className="text-[11px] font-bold tracking-wide text-gray-500">{s}</span><i className="flex-1 h-px bg-mor-line" /></div>
  );
  const line = (label: React.ReactNode, v: React.ReactNode, cls = '') => (
    <div className={`flex justify-between py-1 tabular-nums ${cls}`}><span>{label}</span><span>{v}</span></div>
  );
  const inp = (bad: boolean) => `h-10 w-full rounded-lg border px-2 text-right ${bad ? 'border-red-400 bg-red-50' : 'border-mor-line'}`;

  const body = (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={busy ? undefined : onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="px-5 py-3.5 border-b border-mor-line flex items-center justify-between">
          <div className="min-w-0">
            <b>提前終止契約・結算退款</b>
            <span className="ml-2 text-xs text-gray-400">{c.tenant_name ?? '—'}・{c.room ?? ''}</span>
          </div>
          <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-5 py-4 overflow-y-auto text-sm space-y-3">
          {loading ? <div className="py-8 text-center text-gray-400">載入中…</div> : <>
            {sec('① 終止日（最後住的那一天）')}
            <input type="date" value={end} min={c.start_date ?? undefined} max={c.end_date ?? undefined}
              onChange={(e) => { setEnd(e.target.value); setErr(''); }}
              className={`h-10 w-full rounded-lg border px-2 ${showErr && showErr.includes('終止日') ? 'border-red-400 bg-red-50' : 'border-mor-line'}`} />
            <div className="text-[11px] text-gray-400 -mt-1.5">原本租期 {c.start_date} ～ {c.end_date}；終止日之後的營收與月租單會收掉。</div>

            {sec('② 已收、已住、可以結算的')}
            <div>
              {line(<>租金已收 <span className="text-xs text-gray-400">月租單收款合計</span></>, money(t.rentPaid))}
              {line(<span className="text-gray-500">− 住到終止日 <span className="text-xs text-gray-400">{livedText(c.start_date, end)}</span></span>,
                <span className="text-gray-500">−{money(t.earned)}</span>)}
              {line('＝ 預收沒住的', money(t.prepaid))}
              {line(<>押金 <span className="text-xs text-gray-400">{dep?.returned_on ? '已退過' : dep?.forfeited_on ? '已沒收過' : dep?.received_on ? `已收${fees ? `（已扣加費 ${money(fees)}）` : ''}` : dep ? '還沒收' : '沒有押金'}</span></>, money(t.deposit))}
              {line('可結算合計', money(t.total), 'font-semibold border-t border-mor-line mt-1 pt-2')}
            </div>

            {t.total > 0 && <>
              {sec('③ 沒收多少、退多少')}
              <div className="grid grid-cols-[5.5rem_1fr_1fr] gap-2 items-center">
                <span /><span className="text-xs text-gray-600">沒收</span><span className="text-xs text-gray-600">退還</span>
                <span className="text-xs text-gray-600 leading-tight">預收租金<br /><span className="text-gray-400">{money(t.prepaid)}</span></span>
                <MoneyInput value={split.rentForfeit} onChange={(n) => { setSplit({ ...split, rentForfeit: n }); setErr(''); }}
                  disabled={t.prepaid <= 0} className={inp(split.rentForfeit > t.prepaid)} />
                <MoneyInput value={Math.max(0, r.rent)} onChange={(n) => { setSplit({ ...split, rentForfeit: t.prepaid - n }); setErr(''); }}
                  disabled={t.prepaid <= 0} className={inp(r.rent < 0 || r.rent > t.prepaid)} />
                <span className="text-xs text-gray-600 leading-tight">押金<br /><span className="text-gray-400">{money(t.deposit)}</span></span>
                <MoneyInput value={split.depForfeit} onChange={(n) => { setSplit({ ...split, depForfeit: n }); setErr(''); }}
                  disabled={t.deposit <= 0} className={inp(split.depForfeit > t.deposit)} />
                <MoneyInput value={Math.max(0, r.dep)} onChange={(n) => { setSplit({ ...split, depForfeit: t.deposit - n }); setErr(''); }}
                  disabled={t.deposit <= 0} className={inp(r.dep < 0 || r.dep > t.deposit)} />
                <span className="text-xs font-semibold">合計</span>
                <b className="text-right pr-2 tabular-nums">{money(split.rentForfeit + split.depForfeit)}</b>
                <b className="text-right pr-2 tabular-nums">{money(Math.max(0, r.total))}</b>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-gray-400 mr-0.5">快選</span>
                {termPicks(t).map((q) => (
                  <button key={q.label} onClick={() => { setSplit(q.split); setErr(''); }}
                    className={`rounded-md border px-2 py-0.5 text-[11px] ${split.rentForfeit === q.split.rentForfeit && split.depForfeit === q.split.depForfeit
                      ? 'border-mor-slate bg-mor-bluelight text-mor-slate' : 'border-mor-line text-mor-slate hover:bg-mor-sand/50'}`}>
                    {q.label}{q.split.rentForfeit + q.split.depForfeit > 0 ? ` ${money(q.split.rentForfeit + q.split.depForfeit)}` : ''}
                  </button>
                ))}
              </div>
            </>}
            {showErr && <div className="text-xs text-red-600">{showErr}</div>}

            <label className="flex flex-col gap-1"><span className="text-xs text-gray-600">原因</span>
              <select value={reason} onChange={(e) => setReason(e.target.value)} className="h-10 rounded-lg border border-mor-line px-2 bg-white">
                {REASONS.map((x) => <option key={x}>{x}</option>)}
              </select></label>

            {r.total > 0 && !showErr && (
              <>
                {sec(`④ 退還 ${money(r.total)} 怎麼退`)}
                <RefundFields v={rf} payAccounts={payAccounts} missing={rfMissing}
                  onChange={(patch) => { setRf({ ...rf, ...patch }); setErr(''); }} />
              </>
            )}

            {!showErr && <div className={`rounded-lg px-3 py-2 text-xs ${tone}`}>{TERM_PATH_LABEL[path]}</div>}
            <div className="text-[11px] text-gray-400 leading-relaxed">
              結算後：契約迄日改成 {end}、停用；營收認到 {end}（{money(t.earned)}），之後的月租單收掉。
              {split.rentForfeit + split.depForfeit > 0 && <>沒收的 {money(split.rentForfeit + split.depForfeit)} 記成其他收入{path === 'review' ? '（核可後才記）' : ''}。</>}
              {r.total > 0 && `退還的 ${money(r.total)}（租金 ${money(r.rent)}＋押金 ${money(r.dep)}）在請款審核頁排匯款，匯出後押金變「已退」。`}
            </div>
            {err && <div className="text-xs text-red-600">{err}</div>}
          </>}
        </div>

        <div className="px-5 py-3 border-t border-mor-line flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="h-9 rounded-lg border border-mor-line px-4 text-sm">取消</button>
          <button onClick={go} disabled={busy || loading || !!showErr} title={showErr ?? undefined}
            className="h-9 rounded-lg bg-mor-slate text-white px-4 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-50">
            {busy ? '處理中⋯' : TERM_PATH_BUTTON[path]}</button>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? null : createPortal(body, document.body);
}
