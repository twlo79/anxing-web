'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import { savedToast } from '@/lib/saved-feedback';
import { todayStr } from '@/lib/period';
import { feeOf, PRICING_TITLE, pricingAccountOf, totalsByAccount, ymOfCheckin, orderIdOfKey, recentYms, rowsOfMonth, pickMonth } from '@/lib/pricing-fee';

/*
 * ══════════════════════════════════════════════════════════
 * 調價費支出（migration_312；313 改無條件進位＋自動繳款 4145／8088，2026-10-05 David 過審）
 *
 *   ① 勾選 → ② 預覽 → ③ 產生；歷史紀錄是標題列右邊的連結（不是分頁 ——
 *     「勾選訂單」分頁跟步驟提示講的是同一件事，David：「這邊有點多餘」）。
 *
 * ★ 預覽與產生走**同一支** gen_pricing_fees()（p_dry 分開）—— 金額公式只有一份。
 * ★ 不能重複產生靠資料庫的唯一索引，不是靠這裡的灰色勾選框。
 * ══════════════════════════════════════════════════════════
 */

type Ord = {
  id: string; order_key: string; checkin: string | null; checkout: string | null;
  property_raw: string | null; guest_name: string | null; amount: number | null; estate_id: string | null;
};
type Batch = {
  id: string; created_at: string; created_by: string | null; n: number; total: number;
  yms: string | null; undone_at: string | null;
};
type GenRow = { order_id: string; spent_on: string; item: string; estate_id: string; amount: number; pay_account?: string | null };
type GenSkip = { order_id: string; room: string | null; guest: string | null; checkin: string | null; why: string };
type GenResult = { ok: boolean; n: number; total: number; rows: GenRow[]; skipped: GenSkip[]; message: string };

const money = (n: number) => '$' + Math.round(n).toLocaleString();
const tpeTime = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};

export default function PricingFeeModal({ onClose }: { onClose: () => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [view, setView] = useState<'pick' | 'preview' | 'history'>('pick');
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Ord[]>([]);
  /** 已產生過的訂單 → 產生日期 */
  const [done, setDone] = useState<Map<string, string>>(new Map());
  const [batches, setBatches] = useState<Batch[]>([]);
  const [estName, setEstName] = useState<Map<string, string>>(new Map());
  const [who, setWho] = useState<Map<string, string>>(new Map());
  const [rate, setRate] = useState(0.015);
  const ymNow = todayStr().slice(0, 7).replace('-', '');
  const quick = useMemo(() => recentYms(ymNow), [ymNow]);
  /** 看哪個月；預設上個月 —— 最常做的事是「把上個月的產生掉」 */
  const [mon, setMon] = useState<string>(quick[1]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pv, setPv] = useState<GenResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [o, e, b, es, pf, ws] = await Promise.all([
      fetchAll<Ord>((f, t) => supabase.from('orders')
        .select('id, order_key, checkin, checkout, property_raw, guest_name, amount, estate_id')
        .eq('source', 'airbnb').gt('amount', 0).not('checkin', 'is', null)
        .order('checkin', { ascending: false }).range(f, t)),
      fetchAll<{ auto_key: string; created_at: string }>((f, t) => supabase.from('expenses')
        .select('auto_key, created_at').like('auto_key', 'pricing:order:%').range(f, t)),
      supabase.from('pricing_fee_batches').select('*').order('created_at', { ascending: false }).limit(100),
      supabase.from('estates').select('id, name'),
      supabase.from('profiles').select('id, name'),
      supabase.from('work_settings').select('pricing_fee_rate').eq('id', 1).maybeSingle(),
    ]);
    if (o.error || e.error || b.error) setErr('讀不到資料：' + (o.error ?? e.error ?? b.error?.message));
    setRows(o.rows);
    const d = new Map<string, string>();
    for (const x of e.rows) { const id = orderIdOfKey(x.auto_key); if (id) d.set(id, x.created_at); }
    setDone(d);
    setBatches((b.data ?? []) as Batch[]);
    setEstName(new Map((es.data ?? []).map((x) => [x.id as string, x.name as string])));
    setWho(new Map((pf.data ?? []).map((x) => [x.id as string, (x.name as string) ?? '—'])));
    const r = Number((ws.data as { pricing_fee_rate?: number } | null)?.pricing_fee_rate);
    if (r > 0) setRate(r);
    setLoading(false);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  const doneSet = useMemo(() => new Set(done.keys()), [done]);
  const visible = useMemo(() => rowsOfMonth(rows, mon), [rows, mon]);
  const otherYms = useMemo(() => Array.from(new Set(rows.map((r) => ymOfCheckin(r.checkin))))
    .filter((y) => y && !quick.includes(y)).sort().reverse(), [rows, quick]);
  const selTotal = useMemo(() => rows.filter((r) => sel.has(r.id)).reduce((s, r) => s + feeOf(r.amount, rate), 0), [rows, sel, rate]);
  const openable = visible.filter((r) => !doneSet.has(r.id));
  const allOn = openable.length > 0 && openable.every((r) => sel.has(r.id));

  const chooseMonth = (y: string) => { setMon(y); setSel(pickMonth(rows, y, doneSet)); setErr(''); };
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const preview = async () => {
    if (!sel.size) return setErr('先勾訂單');
    setBusy(true); setErr('');
    const { data, error } = await supabase.rpc('gen_pricing_fees', { p_order_ids: Array.from(sel), p_dry: true });
    setBusy(false);
    if (error) return setErr('預覽失敗：' + error.message);
    setPv(data as GenResult); setView('preview');
  };
  const generate = async () => {
    setBusy(true); setErr('');
    const { data, error } = await supabase.rpc('gen_pricing_fees', { p_order_ids: Array.from(sel), p_dry: false });
    setBusy(false);
    if (error) return setErr('產生失敗：' + error.message);
    const r = data as GenResult;
    if (!r?.ok) return setErr(r?.message ?? '沒有產生');
    savedToast(r.message);
    setSel(new Set()); setPv(null);
    await load();
    setView('history');
  };
  const undo = async (b: Batch) => {
    if (!confirm(`撤銷這一批？\n\n${tpeTime(b.created_at)}・${b.n} 張・${money(b.total)}\n\n那幾筆調價支出會整批拿掉，訂單回到「可以產生」。`)) return;
    setBusy(true); setErr('');
    const { data, error } = await supabase.rpc('undo_pricing_batch', { p_batch: b.id });
    setBusy(false);
    if (error) return setErr('撤銷失敗：' + error.message);
    const r = data as { ok: boolean; message: string };
    if (!r?.ok) return setErr(r?.message ?? '撤銷失敗');
    savedToast(r.message);
    load();
  };

  const live = batches.filter((b) => !b.undone_at).length;
  const step = (n: number, t: string, on: boolean) => (
    <span className={on ? 'font-semibold text-mor-ink' : ''}>{n === 1 ? '①' : n === 2 ? '②' : '③'} {t}</span>
  );
  /** 每一列的付款帳戶：資料庫回的為準（313），舊版函式沒回就照物業名稱推 */
  const acctOf = useCallback((r: GenRow) => r.pay_account || pricingAccountOf(estName.get(r.estate_id)), [estName]);
  const byAcct = useMemo(() => totalsByAccount((pv?.rows ?? []).map((r) => ({ pay_account: acctOf(r), amount: Number(r.amount) }))), [pv, acctOf]);

  const body = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={busy ? undefined : onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[88vh] flex flex-col">
        <div className="px-5 py-3.5 border-b border-mor-line flex items-center gap-2">
          {view === 'history' ? (
            <>
              <button onClick={() => { setView('pick'); setErr(''); }} className="text-sm text-mor-slate">← 回去勾選</button>
              <b className="ml-2">歷史紀錄</b>
            </>
          ) : (
            <>
              <b className="whitespace-nowrap">{PRICING_TITLE}</b>
              <span className="text-xs text-gray-400 truncate">訂單金額 × {+(rate * 100).toFixed(2)}%（無條件進位）・一張訂單一筆・日期記入住日</span>
              <button onClick={() => { setView('history'); setErr(''); }}
                className="ml-auto text-xs text-mor-slate whitespace-nowrap">歷史紀錄 {live} →</button>
            </>
          )}
          <button onClick={onClose} disabled={busy} className={`${view === 'history' ? 'ml-auto' : 'ml-3'} text-gray-400 hover:text-gray-600 text-xl leading-none`}>✕</button>
        </div>

        {/*
          ★ 2026-10-03 David：「表頭跑掉」—— 步驟與月份放在**不捲動**的這一段，
            底下只有表格在捲；表頭貼在捲動區頂端（捲動區上方不能有 padding，不然列會從表頭上面露出來）。
        */}
        {!loading && view !== 'history' && (
          <div className="px-5 pt-3 text-sm">
            <div className="text-[11.5px] text-gray-400 mb-2 flex gap-3">
              {step(1, '勾選', view === 'pick')}<span>→</span>{step(2, '預覽', view === 'preview')}<span>→</span>{step(3, '產生', false)}
            </div>
            {view === 'pick' && (
              <div className="flex flex-wrap items-center gap-1.5 mb-2">
                <span className="text-xs text-gray-400 mr-1">入住月</span>
                {['all', ...quick].map((y) => (
                  <button key={y} onClick={() => chooseMonth(y)}
                    className={`rounded-full border px-3 py-1 text-xs ${mon === y
                      ? 'bg-mor-ink border-mor-ink text-white' : 'bg-white border-mor-line text-gray-600 hover:bg-mor-sand/60'}`}>
                    {y === 'all' ? '全部' : y}
                  </button>
                ))}
                {otherYms.length > 0 && (
                  <select value={otherYms.includes(mon) ? mon : ''} onChange={(e) => e.target.value && chooseMonth(e.target.value)}
                    className={`rounded-full border px-2 py-1 text-xs ${otherYms.includes(mon) ? 'border-mor-ink' : 'border-mor-line'} bg-white`}>
                    <option value="">更早的月份…</option>
                    {otherYms.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                )}
                <span className="ml-auto text-[11px] text-gray-400 hidden md:inline">點月份 ＝ 只列那個月，並把還沒產生的全勾起來</span>
                {/* 2026-10-05 David：「只有 Airbnb 的可以調價」—— 清單與資料庫本來就只收 Airbnb，這顆讓人看得到 */}
                <span className="rounded-md bg-mor-bluelight px-2 py-0.5 text-[11px] text-mor-slate whitespace-nowrap">只列 Airbnb 訂單</span>
              </div>
            )}
          </div>
        )}

        <div className="px-5 pb-3 overflow-y-auto flex-1 text-sm">
          {loading && <div className="py-10 text-center text-gray-400">載入中…</div>}

          {!loading && view === 'pick' && (
            <>
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_#E0DDD5]">
                  <tr className="text-gray-500 border-b border-mor-line">
                    <th className="w-7 py-1.5 text-left">
                      <input type="checkbox" checked={allOn} disabled={!openable.length}
                        onChange={() => setSel((s) => { const n = new Set(s); openable.forEach((r) => allOn ? n.delete(r.id) : n.add(r.id)); return n; })} />
                    </th>
                    <th className="text-left font-medium">入住日</th><th className="text-left font-medium">房源</th>
                    <th className="text-left font-medium">房客</th><th className="text-right font-medium">訂單金額</th>
                    <th className="text-right font-medium">調價</th><th className="text-left font-medium pl-3">狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const d = done.get(r.id);
                    return (
                      <tr key={r.id} className={`border-b border-mor-line/60 ${d ? 'text-gray-400' : ''}`}>
                        <td className="py-1.5"><input type="checkbox" disabled={!!d} checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
                        <td className="tabular-nums">{r.checkin}</td>
                        <td>{r.property_raw ?? '—'}</td>
                        <td className="truncate max-w-[10rem]">{r.guest_name ?? '—'}</td>
                        <td className="text-right tabular-nums">{money(Number(r.amount) || 0)}</td>
                        <td className="text-right tabular-nums">{money(feeOf(r.amount, rate))}</td>
                        <td className="pl-3">{d && <span className="rounded bg-mor-sand px-1.5 py-0.5 text-[10.5px] text-gray-500">已產生 {d.slice(5, 10).replace('-', '/')}</span>}</td>
                      </tr>
                    );
                  })}
                  {!visible.length && <tr><td colSpan={7} className="py-6 text-center text-gray-400">這個月沒有 Airbnb 訂單</td></tr>}
                </tbody>
              </table>
            </>
          )}

          {!loading && view === 'preview' && pv && (
            <>
              <div className="mb-2 pt-1">按「產生支出」之後會寫進支出明細的就是這幾筆 —— 現在還沒寫</div>
              <table className="w-full text-xs">
                <thead><tr className="text-gray-500 border-b border-mor-line">
                  <th className="text-left font-medium py-1.5">日期</th><th className="text-left font-medium">項目</th>
                  <th className="text-left font-medium">用途</th><th className="text-left font-medium">會計科目</th>
                  <th className="text-left font-medium">付款</th>
                  <th className="text-right font-medium">金額</th>
                </tr></thead>
                <tbody>
                  {pv.rows.map((r) => (
                    <tr key={r.order_id} className="border-b border-mor-line/60">
                      <td className="py-1.5 tabular-nums">{r.spent_on}</td><td>{r.item}</td>
                      <td>{estName.get(r.estate_id) ?? '—'}</td><td>專業服務費</td>
                      <td className={`whitespace-nowrap ${acctOf(r) === '4145' ? 'text-mor-slate' : ''}`}>自動繳款・{acctOf(r)}</td>
                      <td className="text-right tabular-nums">{money(Number(r.amount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-1.5 text-[11.5px] text-gray-500">
                {pv.n} 筆・合計 {money(pv.total)}{byAcct.length > 0 && <>　｜　{byAcct.map(([k, v]) => `${k} ${money(v)}`).join('・')}</>}
              </div>
              {pv.skipped.length > 0 && (
                <div className="mt-3 rounded-lg bg-[#FAFAF8] px-3 py-2 text-[11.5px] text-gray-500">
                  <div className="font-semibold mb-0.5">不會產生（{pv.skipped.length} 張）</div>
                  {pv.skipped.map((s) => (
                    <div key={s.order_id}>{s.checkin ?? '—'}　{s.room ?? '—'}　{s.guest ?? ''}　—　{s.why}</div>
                  ))}
                </div>
              )}
            </>
          )}

          {!loading && view === 'history' && (
            <table className="w-full text-xs mt-3">
              <thead><tr className="text-gray-500 border-b border-mor-line">
                <th className="text-left font-medium py-1.5">產生時間</th><th className="text-left font-medium">誰</th>
                <th className="text-right font-medium">張數</th><th className="text-right font-medium">合計</th>
                <th className="text-left font-medium pl-3">入住月</th><th />
              </tr></thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className={`border-b border-mor-line/60 ${b.undone_at ? 'text-gray-400' : ''}`}>
                    <td className="py-1.5 tabular-nums">{tpeTime(b.created_at)}</td>
                    <td>{who.get(b.created_by ?? '') ?? '—'}</td>
                    <td className="text-right tabular-nums">{b.n} 張</td>
                    <td className="text-right tabular-nums">{money(Number(b.total))}</td>
                    <td className="pl-3">{b.yms ?? '—'}</td>
                    <td className="text-right">
                      {b.undone_at
                        ? <span className="text-[10.5px]">已撤銷 {tpeTime(b.undone_at)}</span>
                        : <button onClick={() => undo(b)} disabled={busy} className="text-xs text-red-500 hover:text-red-700">撤銷</button>}
                    </td>
                  </tr>
                ))}
                {!batches.length && <tr><td colSpan={6} className="py-6 text-center text-gray-400">還沒有產生過</td></tr>}
              </tbody>
            </table>
          )}
        </div>

        {/* 底列：錯誤訊息留在這裡（動作發生的地方），不跳到頁面最上方 */}
        {!loading && view !== 'history' && (
          <div className="px-5 py-3 border-t border-mor-line flex items-center gap-3">
            {view === 'pick' ? (
              <>
                <span className="text-sm">已選 {sel.size} 張・調價合計 {money(selTotal)}</span>
                {err && <span className="text-xs text-red-600">{err}</span>}
                <button onClick={preview} disabled={busy}
                  className="ml-auto h-9 rounded-lg border border-mor-line px-4 text-sm hover:bg-mor-sand/50">
                  {busy ? '計算中⋯' : '預覽支出 →'}</button>
              </>
            ) : (
              <>
                {err && <span className="text-xs text-red-600">{err}</span>}
                <button onClick={() => { setView('pick'); setErr(''); }} disabled={busy}
                  className="ml-auto h-9 rounded-lg border border-mor-line px-4 text-sm">← 回去改</button>
                <button onClick={generate} disabled={busy || !pv?.n}
                  title={!pv?.n ? '勾的訂單一張都不能產生' : undefined}
                  className="h-9 rounded-lg bg-mor-slate text-white px-4 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-50">
                  {busy ? '產生中⋯' : `產生支出${pv?.n ? `（${pv.n} 筆）` : ''}`}</button>
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
