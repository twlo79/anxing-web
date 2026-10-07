'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import { savedToast } from '@/lib/saved-feedback';
import { todayStr } from '@/lib/period';
import { TAG_NON_CASH } from '@/lib/expense-tags';
import { PAY_LABEL, PAY_OPTS } from '@/lib/purchase-pay';
import { recentYms } from '@/lib/pricing-fee';
import { ncRowsOf, ncPick, ncTotal, ncYmOf } from '@/lib/noncash';

/*
 * ══════════════════════════════════════════════════════════
 * 💸 轉成實支（migration_322，2026-10-07 David 過審；參考調價費支出的視窗）
 *
 *   ① 勾選（物業、支出月篩選；點月份＝只列那個月並全勾）→ ② 填付款（方式、帳號、實際付款日）→ ③ 完成
 *   歷史紀錄在標題列右邊，每一批可以撤銷（改回非實支）。
 *
 * ★ 真正的規則在資料庫 convert_noncash()／undo_noncash_batch()：
 *   不是非實支、已關帳月份的會被跳過並講原因。金額、日期、科目一律不動。
 * ══════════════════════════════════════════════════════════
 */

type Exp = { id: string; spent_on: string; item_name: string; amount: number; account_code: string | null; estate_id: string | null };
type Batch = { id: string; created_at: string; created_by: string | null; n: number; total: number;
  payment_method: string | null; pay_account: string | null; paid_on: string | null; yms: string | null; estates: string | null; undone_at: string | null };
type Acct = { code: string; name: string; method: string | null; book: string | null };

const money = (n: number) => '$' + Math.round(n).toLocaleString();
const tpe = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export default function NoncashModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [view, setView] = useState<'pick' | 'pay' | 'history'>('pick');
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Exp[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [estates, setEstates] = useState<{ id: string; name: string }[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [accts, setAccts] = useState<Acct[]>([]);
  const [who, setWho] = useState<Record<string, string>>({});
  const [est, setEst] = useState('');
  const ymNow = todayStr().slice(0, 7).replace('-', '');
  const quick = useMemo(() => recentYms(ymNow), [ymNow]);
  const [mon, setMon] = useState('all');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState('transfer');
  const [acct, setAcct] = useState('');
  const [paidOn, setPaidOn] = useState(todayStr());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [e, b, es, ac, pa, pf] = await Promise.all([
      fetchAll<Exp>((f, t) => supabase.from('expenses').select('id, spent_on, item_name, amount, account_code, estate_id')
        .contains('tags', [TAG_NON_CASH]).order('spent_on', { ascending: false }).range(f, t)),
      supabase.from('noncash_batches').select('*').order('created_at', { ascending: false }).limit(100),
      supabase.from('estates').select('id, name').order('sort'),
      supabase.from('account_codes').select('code, name'),
      supabase.from('payment_accounts').select('code, name, method, book').eq('active', true).order('sort'),
      supabase.from('profiles').select('id, name'),
    ]);
    if (e.error || b.error) setErr('讀不到資料：' + (e.error ?? b.error?.message));
    setRows(e.rows.map((x) => ({ ...x, amount: Number(x.amount) })));
    setBatches((b.data ?? []) as Batch[]);
    setEstates((es.data ?? []) as { id: string; name: string }[]);
    setCodes(Object.fromEntries((ac.data ?? []).map((x) => [x.code as string, x.name as string])));
    setAccts(((pa.data ?? []) as Acct[]).filter((x) => (x.book ?? 'anxing') === 'anxing'));
    setWho(Object.fromEntries((pf.data ?? []).map((x) => [x.id as string, (x.name as string) ?? '—'])));
    setLoading(false);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  const estName = useMemo(() => Object.fromEntries(estates.map((x) => [x.id, x.name])), [estates]);
  const visible = useMemo(() => ncRowsOf(rows, est, mon), [rows, est, mon]);
  const otherYms = useMemo(() => Array.from(new Set(rows.map((r) => ncYmOf(r.spent_on)))).filter((y) => !quick.includes(y)).sort().reverse(), [rows, quick]);
  const usedEst = useMemo(() => estates.filter((x) => rows.some((r) => r.estate_id === x.id)), [estates, rows]);
  const picked = useMemo(() => rows.filter((r) => sel.has(r.id)), [rows, sel]);
  const allOn = visible.length > 0 && visible.every((r) => sel.has(r.id));
  // 現金→現金帳戶、信用卡→卡、其他（匯款、臨櫃、自動繳款）→銀行帳戶
  const acctOpts = accts.filter((a) => (method === 'cash' ? a.method === 'cash'
    : method === 'credit_card' ? a.method === 'credit_card' : a.method !== 'cash' && a.method !== 'credit_card'));

  const choose = (e: string, m: string) => { setEst(e); setMon(m); setSel(ncPick(rows, e, m)); setErr(''); };
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const convert = async () => {
    if (busy) return;
    if (!method) return setErr('先選付款方式');
    if (!paidOn) return setErr('先填實際付款日');
    setBusy(true); setErr('');
    const { data, error } = await supabase.rpc('convert_noncash', {
      p_ids: Array.from(sel), p_method: method, p_account: acct || null, p_paid_on: paidOn });
    setBusy(false);
    if (error) return setErr('沒轉成：' + error.message);
    const r = data as { ok: boolean; message: string; skipped?: { item: string; why: string }[] };
    if (!r?.ok) return setErr(r?.message ?? '沒轉成');
    savedToast(r.message + (r.skipped?.length ? `（跳過 ${r.skipped.length} 筆）` : ''));
    setSel(new Set()); await load(); onDone(); setView('history');
  };
  const undo = async (b: Batch) => {
    if (!confirm(`撤銷這一批？\n\n${tpe(b.created_at)}・${b.n} 筆・${money(Number(b.total))}\n\n那幾筆會改回非實支，付款方式、帳號、備註放回原本的樣子。`)) return;
    setBusy(true); setErr('');
    const { data, error } = await supabase.rpc('undo_noncash_batch', { p_batch: b.id });
    setBusy(false);
    if (error) return setErr('撤銷失敗：' + error.message);
    const r = data as { ok: boolean; message: string };
    if (!r?.ok) return setErr(r?.message ?? '撤銷失敗');
    savedToast(r.message); await load(); onDone();
  };

  const live = batches.filter((b) => !b.undone_at).length;
  const pill = (on: boolean) => `rounded-full border px-3 py-1 text-xs ${on ? 'bg-mor-ink border-mor-ink text-white' : 'bg-white border-mor-line text-gray-600 hover:bg-mor-sand/60'}`;
  const step = (n: number, t: string, on: boolean) => <span className={on ? 'font-semibold text-mor-ink' : ''}>{'①②③'[n - 1]} {t}</span>;

  const body = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={busy ? undefined : onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[88vh] flex flex-col">
        <div className="px-5 py-3.5 border-b border-mor-line flex items-center gap-2">
          {view === 'history' ? (
            <><button onClick={() => { setView('pick'); setErr(''); }} className="text-sm text-mor-slate">← 回去勾選</button><b className="ml-2">歷史紀錄</b></>
          ) : (
            <><b className="whitespace-nowrap">💸 轉成實支</b>
              <span className="text-xs text-gray-400 truncate">把非實支的支出補上付款資訊・金額日期科目不動</span>
              <button onClick={() => { setView('history'); setErr(''); }} className="ml-auto text-xs text-mor-slate whitespace-nowrap">歷史紀錄 {live} →</button></>
          )}
          <button onClick={onClose} disabled={busy} className={`${view === 'history' ? 'ml-auto' : 'ml-3'} text-gray-400 hover:text-gray-600 text-xl leading-none`}>✕</button>
        </div>

        {!loading && view !== 'history' && (
          <div className="px-5 pt-3 text-sm">
            <div className="text-[11.5px] text-gray-400 mb-2 flex gap-3">
              {step(1, '勾選', view === 'pick')}<span>→</span>{step(2, '填付款', view === 'pay')}<span>→</span>{step(3, '完成', false)}
            </div>
            {view === 'pick' && (
              <>
                <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                  <span className="text-xs text-gray-400 mr-1">物業</span>
                  <button onClick={() => choose('', mon)} className={pill(est === '')}>全部</button>
                  {usedEst.map((x) => <button key={x.id} onClick={() => choose(x.id, mon)} className={pill(est === x.id)}>{x.name}</button>)}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mb-2">
                  <span className="text-xs text-gray-400 mr-1">支出月</span>
                  {['all', ...quick].map((y) => <button key={y} onClick={() => choose(est, y)} className={pill(mon === y)}>{y === 'all' ? '全部' : y}</button>)}
                  {otherYms.length > 0 && (
                    <select value={otherYms.includes(mon) ? mon : ''} onChange={(e) => e.target.value && choose(est, e.target.value)}
                      className={`rounded-full border px-2 py-1 text-xs bg-white ${otherYms.includes(mon) ? 'border-mor-ink' : 'border-mor-line'}`}>
                      <option value="">更早的月份…</option>
                      {otherYms.map((y) => <option key={y} value={y}>{y}</option>)}
                    </select>
                  )}
                  <span className="ml-auto text-[11px] text-gray-400 hidden md:inline">點物業或月份＝只列那些並全勾</span>
                </div>
              </>
            )}
            {view === 'pay' && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-600">付款方式</span>
                  <select value={method} onChange={(e) => { setMethod(e.target.value); setAcct(''); }} className="h-9 rounded-lg border border-mor-line px-2 bg-white">
                    {PAY_OPTS.map((m) => <option key={m} value={m}>{PAY_LABEL[m] ?? m}</option>)}
                  </select></label>
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-600">{method === 'cash' ? '現金從哪裡出' : '安幸付款帳號'}</span>
                  <select value={acct} onChange={(e) => setAcct(e.target.value)} className="h-9 rounded-lg border border-mor-line px-2 bg-white">
                    <option value="">—</option>
                    {acctOpts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                  </select></label>
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-600">實際付款日</span>
                  <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className="h-9 rounded-lg border border-mor-line px-2" /></label>
              </div>
            )}
          </div>
        )}

        <div className="px-5 pb-3 overflow-y-auto flex-1 text-sm">
          {loading && <div className="py-10 text-center text-gray-400">載入中…</div>}

          {!loading && view !== 'history' && (
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_#E0DDD5]">
                <tr className="text-gray-500">
                  {view === 'pick' && <th className="w-7 py-1.5 text-left">
                    <input type="checkbox" checked={allOn} disabled={!visible.length}
                      onChange={() => setSel((s) => { const n = new Set(s); visible.forEach((r) => allOn ? n.delete(r.id) : n.add(r.id)); return n; })} /></th>}
                  <th className="text-left font-medium py-1.5">支出日</th><th className="text-left font-medium">項目</th>
                  <th className="text-left font-medium">科目</th><th className="text-left font-medium">物業</th>
                  <th className="text-right font-medium">金額</th>
                  {view === 'pay' && <th className="text-left font-medium pl-3">寫進去的付款</th>}
                </tr>
              </thead>
              <tbody>
                {(view === 'pick' ? visible : picked).map((r) => (
                  <tr key={r.id} className="border-b border-mor-line/60">
                    {view === 'pick' && <td className="py-1.5"><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>}
                    <td className="py-1.5 tabular-nums">{r.spent_on}</td>
                    <td className="truncate max-w-[14rem]">{r.item_name}</td>
                    <td>{r.account_code ? codes[r.account_code] ?? r.account_code : '—'}</td>
                    <td>{r.estate_id ? estName[r.estate_id] ?? '—' : '—'}</td>
                    <td className="text-right tabular-nums">{money(r.amount)}</td>
                    {view === 'pay' && <td className="pl-3 whitespace-nowrap">{PAY_LABEL[method] ?? method}{acct ? `・${accts.find((a) => a.code === acct)?.name ?? acct}` : ''}</td>}
                  </tr>
                ))}
                {view === 'pick' && !visible.length && <tr><td colSpan={6} className="py-6 text-center text-gray-400">{rows.length ? '這個條件下沒有非實支的支出' : '目前沒有非實支的支出'}</td></tr>}
              </tbody>
            </table>
          )}
          {!loading && view === 'pay' && (
            <p className="text-[11px] text-gray-400 mt-2">每一筆：拿掉「{TAG_NON_CASH}」標籤、填上付款方式與帳號，備註追加一行「轉實支 {paidOn}」。金額、日期、科目都不動。已關帳月份的會跳過。</p>
          )}

          {!loading && view === 'history' && (
            <table className="w-full text-xs mt-3">
              <thead><tr className="text-gray-500 border-b border-mor-line">
                <th className="text-left font-medium py-1.5">轉換時間</th><th className="text-left font-medium">誰</th>
                <th className="text-right font-medium">筆數</th><th className="text-right font-medium">合計</th>
                <th className="text-left font-medium pl-3">付款</th><th className="text-left font-medium">物業・月份</th><th />
              </tr></thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className={`border-b border-mor-line/60 ${b.undone_at ? 'text-gray-400' : ''}`}>
                    <td className="py-1.5 tabular-nums">{tpe(b.created_at)}</td>
                    <td>{who[b.created_by ?? ''] ?? '—'}</td>
                    <td className="text-right tabular-nums">{b.n} 筆</td>
                    <td className="text-right tabular-nums">{money(Number(b.total))}</td>
                    <td className="pl-3 whitespace-nowrap">{b.payment_method ? PAY_LABEL[b.payment_method] ?? b.payment_method : '—'}{b.pay_account ? `・${b.pay_account}` : ''}{b.paid_on ? `・${b.paid_on.slice(5)}` : ''}</td>
                    <td className="truncate max-w-[10rem]">{[b.estates, b.yms].filter(Boolean).join('・') || '—'}</td>
                    <td className="text-right">
                      {b.undone_at ? <span className="text-[10.5px]">已撤銷 {tpe(b.undone_at)}</span>
                        : <button onClick={() => undo(b)} disabled={busy} className="text-xs text-red-500 hover:text-red-700">撤銷</button>}
                    </td>
                  </tr>
                ))}
                {!batches.length && <tr><td colSpan={7} className="py-6 text-center text-gray-400">還沒有轉過</td></tr>}
              </tbody>
            </table>
          )}
        </div>

        {!loading && view !== 'history' && (
          <div className="px-5 py-3 border-t border-mor-line flex items-center gap-3">
            <span className="text-sm">已選 {sel.size} 筆・合計 {money(ncTotal(rows, sel))}</span>
            {err && <span className="text-xs text-red-600">{err}</span>}
            {view === 'pick' ? (
              <button onClick={() => { if (!sel.size) return setErr('先勾支出'); setErr(''); setView('pay'); }}
                className="ml-auto h-9 rounded-lg bg-mor-slate text-white px-4 text-sm font-medium hover:bg-mor-slatedark">下一步：填付款 →</button>
            ) : (
              <>
                <button onClick={() => { setView('pick'); setErr(''); }} disabled={busy} className="ml-auto h-9 rounded-lg border border-mor-line px-4 text-sm">← 回去改</button>
                <button onClick={convert} disabled={busy}
                  className="h-9 rounded-lg bg-mor-slate text-white px-4 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-50">
                  {busy ? '處理中⋯' : `確認轉成實支（${sel.size} 筆）`}</button>
              </>
            )}
          </div>
        )}
        {view === 'history' && err && <div className="px-5 py-2 border-t border-mor-line text-xs text-red-600">{err}</div>}
      </div>
    </div>
  );
  return typeof document === 'undefined' ? null : createPortal(body, document.body);
}
