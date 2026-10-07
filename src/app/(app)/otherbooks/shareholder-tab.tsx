'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { fmtInt as fmt } from '@/lib/fmt';
import { todayStr } from '@/lib/period';
import { savedToast } from '@/lib/saved-feedback';
import Req from '@/components/Req';
import MoneyInput from '@/components/MoneyInput';
import Receipts, { type ReceiptsHandle } from '@/components/Receipts';
import StatCard, { StatRow } from '@/components/StatCard';
import {
  byHolder, shTotals, runningOwed, lastPeer, shMissing, DIR_LABEL, DIR_SHORT, METHOD_LABEL,
  methodFieldLabel, accountFieldLabel, peerFieldLabel, type ShTxn, type ShDir, type ShMethod,
} from '@/lib/shareholder';

/*
 * ══════════════════════════════════════════════════════════
 * 安幸・股東往來（migration_321，2026-10-07 David 過審）
 *
 *   卡片：股東借給公司（累計）／公司已還股東（本年）／公司尚欠股東
 *   依股東：一排標籤，點一位只看他的
 *   明細：日期｜股東｜類別｜摘要｜股東→公司｜公司→股東｜該股東餘額
 *   表單：收支（下拉）→ 日期、股東、金額 → 摘要 → 錢怎麼走（方式、安幸帳號、股東帳號）→ 憑證照片
 *
 * ★ 負債，不進營收與損益。權限跟其他收支帳同一組（RLS 在 migration_321）。
 * ══════════════════════════════════════════════════════════
 */

type Acct = { code: string; name: string; method: string | null; book: string | null };
type Draft = Omit<ShTxn, 'id'> & { id?: string };

const CTRL = 'h-10 md:h-9 w-full rounded-lg border px-2 bg-white';
const blank = (dir: ShDir): Draft => ({
  txn_date: todayStr(), shareholder: '', direction: dir, amount: 0, method: 'transfer',
  account_code: null, peer_bank_code: '', peer_account: '', summary: '',
});

export default function ShareholderTab() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<ShTxn[]>([]);
  const [accts, setAccts] = useState<Acct[]>([]);
  const [loading, setLoading] = useState(true);
  const [who, setWho] = useState('');
  const [d, setD] = useState<Draft | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const recRef = useRef<ReceiptsHandle>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: r, error }, { data: a }] = await Promise.all([
      supabase.from('shareholder_txns').select('*').order('txn_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('payment_accounts').select('code, name, method, book').eq('active', true).order('sort'),
    ]);
    if (error) setErr('讀不到股東往來：' + error.message);
    setRows(((r ?? []) as ShTxn[]).map((x) => ({ ...x, amount: Number(x.amount) })));
    setAccts(((a ?? []) as Acct[]).filter((x) => (x.book ?? 'anxing') === 'anxing'));
    setLoading(false);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  const year = todayStr().slice(0, 4);
  const tot = useMemo(() => shTotals(rows, year), [rows, year]);
  const holders = useMemo(() => byHolder(rows), [rows]);
  const owedAt = useMemo(() => runningOwed(rows), [rows]);
  const shown = useMemo(() => (who ? rows.filter((r) => r.shareholder.trim() === who) : rows), [rows, who]);
  const acctName = useMemo(() => Object.fromEntries(accts.map((a) => [a.code, a.name])), [accts]);
  const acctsFor = (m: ShMethod) => accts.filter((a) => (m === 'cash' ? a.method === 'cash' : a.method !== 'cash'));

  const missing = d ? shMissing(d) : [];
  const bad = (f: string) => tried && missing.includes(f);

  const open = (x: Draft) => { setD(x); setTried(false); setErr(''); };
  const setHolder = (name: string) => {
    if (!d) return;
    const p = d.peer_account ? null : lastPeer(rows, name);   // 帳號空著才帶上次的
    setD({ ...d, shareholder: name, ...(p ? { peer_bank_code: p.bank, peer_account: p.account } : {}) });
  };

  const save = async () => {
    if (!d || busy) return;
    setTried(true);
    if (missing.length) return setErr('還沒填：' + missing.join('、'));
    setBusy(true); setErr('');
    const payload = {
      txn_date: d.txn_date, shareholder: d.shareholder.trim(), direction: d.direction, amount: Math.round(d.amount),
      method: d.method, account_code: d.account_code || null,
      peer_bank_code: d.method === 'transfer' ? (d.peer_bank_code || '').trim() || null : null,
      peer_account: d.method === 'transfer' ? (d.peer_account || '').trim() || null : null,
      summary: (d.summary || '').trim() || null,
    };
    const res = d.id
      ? await supabase.from('shareholder_txns').update(payload).eq('id', d.id).select('id')
      : await supabase.from('shareholder_txns').insert(payload).select('id');
    if (res.error || !res.data?.length) { setBusy(false); return setErr('沒存到：' + (res.error?.message ?? '多半是沒有權限')); }
    const id = res.data[0].id as string;
    const upErr = d.id ? null : await recRef.current?.flush(id);
    setBusy(false);
    if (upErr) setErr('資料存好了，但照片沒傳上去：' + upErr);
    else setD(null);
    savedToast(`${d.id ? '已儲存' : '已新增'}：${payload.shareholder} ${DIR_SHORT[d.direction]} $${fmt(payload.amount)}`);
    load();
  };

  const del = async () => {
    if (!d?.id) return;
    if (!confirm(`刪除這筆股東往來？\n\n${d.txn_date}・${d.shareholder}・${DIR_SHORT[d.direction]} $${fmt(d.amount)}\n\n不可復原（照片一起刪）。`)) return;
    setBusy(true);
    const { data, error } = await supabase.from('shareholder_txns').delete().eq('id', d.id).select('id');
    setBusy(false);
    if (error || !data?.length) return setErr('沒刪掉：' + (error?.message ?? '多半是沒有權限'));
    setD(null); savedToast('已刪除'); load();
  };

  const sec = (t: string) => (
    <div className="col-span-2 flex items-center gap-2 mt-1">
      <span className="text-[11px] font-bold tracking-wide text-gray-500">{t}</span><i className="flex-1 h-px bg-mor-line" />
    </div>
  );

  return (
    <div>
      <StatRow cols={3} className="mb-3">
        <StatCard label="股東借給公司（累計）" value={fmt(tot.inSum)} />
        <StatCard label="公司已還股東" value={fmt(tot.outSum)} sub={`本年 ${fmt(tot.outYear)}`} />
        <StatCard label="公司尚欠股東" value={fmt(tot.owed)} sub={`${tot.owingHolders} 位股東`} />
      </StatRow>

      {holders.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          <button onClick={() => setWho('')}
            className={`rounded-lg border px-3 py-1.5 text-sm ${!who ? 'border-mor-slate bg-mor-bluelight' : 'border-mor-line bg-white'}`}>
            全部 <b className="tabular-nums">{fmt(tot.owed)}</b>
          </button>
          {holders.map((h) => (
            <button key={h.name} onClick={() => setWho(who === h.name ? '' : h.name)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${who === h.name ? 'border-mor-slate bg-mor-bluelight' : 'border-mor-line bg-white'}`}>
              {h.name} {h.owed === 0 ? <span className="text-gray-400">已結清</span>
                : h.owed > 0 ? <>欠 <b className="tabular-nums">{fmt(h.owed)}</b></>
                : <span className="text-amber-700">反欠公司 {fmt(-h.owed)}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 mb-2">
        <span className="text-xs text-gray-400 mr-1">共 {shown.length} 筆</span>
        <button onClick={() => open(blank('in'))}
          className="h-9 rounded-lg bg-mor-slate px-3.5 text-sm font-medium text-white hover:bg-mor-slatedark">＋ 股東借入</button>
        <button onClick={() => open(blank('out'))}
          className="h-9 rounded-lg border border-mor-line bg-white px-3.5 text-sm hover:bg-mor-sand/60">＋ 還股東</button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-mor-line">
        <table className="w-full text-sm">
          <thead className="bg-mor-sand/60 text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">日期</th>
              <th className="px-3 py-2 text-left font-medium">股東</th>
              <th className="px-3 py-2 text-left font-medium">類別</th>
              <th className="px-3 py-2 text-left font-medium">摘要</th>
              <th className="px-3 py-2 text-left font-medium">安幸帳號</th>
              <th className="px-3 py-2 text-right font-medium">股東→公司</th>
              <th className="px-3 py-2 text-right font-medium">公司→股東</th>
              <th className="px-3 py-2 text-right font-medium">該股東餘額</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : !shown.length ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">還沒有股東往來 —— 按右上「＋ 股東借入」記第一筆</td></tr>
            : shown.map((r) => {
              const bal = owedAt.get(r.id) ?? 0;
              return (
                <tr key={r.id} onClick={() => open({ ...r, peer_bank_code: r.peer_bank_code ?? '', peer_account: r.peer_account ?? '', summary: r.summary ?? '' })}
                  className="border-t border-mor-line/60 cursor-pointer hover:bg-mor-bluelight/30">
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums text-gray-500">{r.txn_date}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.shareholder}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${r.direction === 'in' ? 'bg-mor-greenlight text-mor-greendark' : 'bg-amber-50 text-amber-700'}`}>{DIR_SHORT[r.direction]}</span>
                  </td>
                  <td className="px-3 py-2 max-w-[18rem] truncate">{r.summary || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">
                    {METHOD_LABEL[r.method]}{r.account_code ? `・${acctName[r.account_code] ?? r.account_code}` : ''}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-mor-greendark">{r.direction === 'in' ? fmt(r.amount) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-600">{r.direction === 'out' ? fmt(r.amount) : '—'}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${bal < 0 ? 'text-amber-700' : ''}`}>{fmt(bal)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-400 mt-2">「該股東餘額」＝ 到那一筆為止公司還欠這位股東多少（借入加、還款減）；負數＝股東反欠公司。股東往來是負債，不進營收與損益。</p>
      {err && !d && <div className="mt-2 text-xs text-red-600">{err}</div>}

      {d && (
        <div className="fixed inset-0 bg-black/30 flex items-stretch md:items-center justify-center md:py-10 z-50" onClick={() => !busy && setD(null)}>
          <div className="bg-white w-full md:w-[560px] md:max-w-[95vw] md:rounded-xl shadow-xl flex flex-col h-full md:h-auto md:max-h-[88vh]"
            onClick={(e) => e.stopPropagation()}>
            <div className="shrink-0 border-b border-mor-line px-4 md:px-6 py-4 flex items-center justify-between">
              <span className="font-bold">{d.id ? '編輯股東往來' : '新增股東往來'}</span>
              <button onClick={() => setD(null)} disabled={busy} aria-label="關閉" className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 md:p-6 text-sm">
              <div className="grid grid-cols-2 gap-3">
                {sec('基本')}
                <label className="flex flex-col gap-1"><span className="flex items-center text-xs text-gray-600">收支<Req /></span>
                  <select value={d.direction} onChange={(e) => setD({ ...d, direction: e.target.value as ShDir })} className={`${CTRL} border-mor-line`}>
                    <option value="in">{DIR_LABEL.in}</option><option value="out">{DIR_LABEL.out}</option>
                  </select></label>
                <label className="flex flex-col gap-1"><span className="flex items-center text-xs text-gray-600">日期<Req /></span>
                  <input type="date" value={d.txn_date} onChange={(e) => setD({ ...d, txn_date: e.target.value })}
                    className={`${CTRL} ${bad('日期') ? 'border-red-400 bg-red-50' : 'border-mor-line'}`} /></label>
                <label className="flex flex-col gap-1"><span className="flex items-center text-xs text-gray-600">股東<Req /></span>
                  <input list="sh-holders" value={d.shareholder} onChange={(e) => setHolder(e.target.value)} placeholder="David"
                    className={`${CTRL} ${bad('股東') ? 'border-red-400 bg-red-50' : 'border-mor-line'}`} />
                  <datalist id="sh-holders">{holders.map((h) => <option key={h.name} value={h.name} />)}</datalist></label>
                <label className="flex flex-col gap-1"><span className="flex items-center text-xs text-gray-600">金額<Req /></span>
                  <MoneyInput value={d.amount || 0} onChange={(n) => setD({ ...d, amount: n })} placeholder="0"
                    className={`${CTRL} text-right ${bad('金額') ? 'border-red-400 bg-red-50' : 'border-mor-line'}`} /></label>
                {/* 摘要是重要的（2026-10-07 David：「摘要是重要的不是其他，往上移」）*/}
                <label className="col-span-2 flex flex-col gap-1"><span className="text-xs text-gray-600">摘要</span>
                  <input value={d.summary ?? ''} onChange={(e) => setD({ ...d, summary: e.target.value })} placeholder="股東借款９月１０日"
                    className={`${CTRL} border-mor-line`} /></label>

                {sec('錢怎麼走')}
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-600">{methodFieldLabel(d.direction)}</span>
                  <select value={d.method} onChange={(e) => setD({ ...d, method: e.target.value as ShMethod, account_code: null })}
                    className={`${CTRL} border-mor-line`}>
                    <option value="transfer">匯款</option><option value="cash">現金</option>
                  </select></label>
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-600">{accountFieldLabel(d.direction, d.method)}</span>
                  <select value={d.account_code ?? ''} onChange={(e) => setD({ ...d, account_code: e.target.value || null })}
                    className={`${CTRL} border-mor-line`}>
                    <option value="">—</option>
                    {acctsFor(d.method).map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                  </select></label>
                {d.method === 'transfer' && (
                  <div className="col-span-2 grid grid-cols-2 gap-3 rounded-lg bg-[#FAFAF9] p-3">
                    <div className="col-span-2 text-[11px] text-gray-500">{peerFieldLabel(d.direction)}</div>
                    <label className="flex flex-col gap-1"><span className="text-xs text-gray-600">銀行代碼</span>
                      <input value={d.peer_bank_code ?? ''} onChange={(e) => setD({ ...d, peer_bank_code: e.target.value })} placeholder="812"
                        className={`${CTRL} border-mor-line`} /></label>
                    <label className="flex flex-col gap-1"><span className="text-xs text-gray-600">帳號</span>
                      <input value={d.peer_account ?? ''} onChange={(e) => setD({ ...d, peer_account: e.target.value })}
                        className={`${CTRL} border-mor-line`} /></label>
                  </div>
                )}

                {sec('憑證')}
                <div className="col-span-2">
                  {d.id ? <Receipts kind="sh" parentId={d.id} canEdit label="匯款水單／照片" />
                        : <Receipts ref={recRef} kind="sh" parentId={null} canEdit label="匯款水單／照片（選填）" />}
                </div>
              </div>
              {err && <div className="mt-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">{err}</div>}
              {d.id && (
                <div className="mt-4 text-center">
                  <button onClick={del} disabled={busy} className="text-xs text-red-400 underline hover:text-red-600">
                    刪除這筆股東往來（不可復原）
                  </button>
                </div>
              )}
            </div>
            <div className="shrink-0 border-t border-mor-line px-4 md:px-6 py-3 flex gap-2">
              <button onClick={() => setD(null)} disabled={busy} className="flex-1 h-11 md:h-9 rounded-lg border border-gray-300 text-sm">取消</button>
              <button onClick={save} disabled={busy} className="flex-1 h-11 md:h-9 rounded-lg bg-mor-slate text-white text-sm font-medium disabled:opacity-40">
                {busy ? '儲存中…' : '儲存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
