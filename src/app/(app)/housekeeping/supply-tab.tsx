'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import Req from '@/components/Req';
import { newItemError, needsInitTxn } from '@/lib/supply-item';
import { useProfile } from '@/lib/profile';
import {
  KIND_LABEL, KIND_BUTTON, txnRow, txnError, previewAfter, negativeWarn,
  isLow, expiringSoon, countDiff, countPlan, countConfirm,
  ZERO_BALANCE,
  type Balance, type CountDraft, type SupplyItem,
} from '@/lib/supply';

/**
 * 備品管理（房務管理的第四個分頁，migration_227）。
 *
 * ============================================================
 * 【這一頁回答一個問題】
 *
 *   **櫃子裡還剩多少？**
 *
 * 其餘都是為了讓那個數字是對的:取用要記、補貨要記、
 * 月底盤一次把帳面跟實際對齊。
 *
 * ============================================================
 * 【★★★ 餘量是算出來的，不是存的】
 *
 * 餘量來自 `supply_balance` 這個 view（`sum(qty)`）——
 * 畫面上**沒有任何地方可以直接改餘量**。
 *
 * 做成可以填的格子的話它會變成第二個真相，而它遲早跟流水對不上。
 * 這個專案的 `bank_transactions.balance` 就是這樣錯了半年
 * （CLAUDE.md:「推導值存成欄位」）。
 *
 * ★ 要改餘量只有兩條路:記一筆取用／補貨，或月底盤點。
 *   兩條都留下「誰、哪一天、為什麼」。
 *
 * ============================================================
 * 【用語】（2026-09-07 使用者選 B）
 *
 *   取用（−）／補貨（＋）。**不是**領用／入庫 ——
 *   按的人是管家跟房務，不是倉管，他們腦中沒有「庫」這個東西。
 *   字在 `lib/supply.ts` 的 `KIND_LABEL`，這裡不另外寫一份。
 */

type Row = SupplyItem & { bal: Balance };
type Estate = { id: string; name: string };

const inp = 'rounded-lg border border-gray-300 px-2 py-1.5 text-sm';
const today = () => new Date().toISOString().slice(0, 10);
const nowYm = () => today().slice(0, 4) + today().slice(5, 7);

export default function SupplyTab({ onMsg }: { onMsg: (t: string, err?: boolean) => void }) {
  const supabase = useMemo(() => createClient(), []);
  const { profile, role } = useProfile();
  /** 建品項與設初始量是會計以上 —— 房務不該能新增品項（會長出一堆同義詞） */
  const canEditItem = ['accountant', 'manager', 'super_admin'].includes(role ?? '');

  const [estates, setEstates] = useState<Estate[]>([]);
  const [estate, setEstate] = useState<string>('');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from('estates').select('id, name').eq('active', true).order('sort')
      .then(({ data }) => {
        const es = (data ?? []) as Estate[];
        setEstates(es);
        setEstate((cur) => cur || es[0]?.id || '');
      });
  }, [supabase]);

  const load = useCallback(async () => {
    if (!estate) return;
    setLoading(true);
    /*
     * ★ 品項與餘量分兩次查再併起來。
     *   `supply_balance` 是 view，PostgREST 的巢狀查詢接不到它 ——
     *   硬接的話回的是空陣列而**不會報錯**，畫面上每一列都是 0
     *   （而 0 看起來是一個很正常的數字）。
     */
    const [it, bal] = await Promise.all([
      supabase.from('supply_item').select('*')
        .eq('estate_id', estate).eq('active', true).order('sort').order('name'),
      supabase.from('supply_balance').select('*'),
    ]);
    setLoading(false);
    if (it.error) { onMsg('讀不到備品：' + it.error.message, true); return; }
    if (bal.error) { onMsg('讀不到庫存餘量：' + bal.error.message, true); return; }

    const byId = Object.fromEntries(
      ((bal.data ?? []) as Balance[]).map((b) => [b.item_id, b]));
    setRows(((it.data ?? []) as SupplyItem[]).map((i) => ({
      ...i,
      bal: byId[i.id] ?? { item_id: i.id, ...ZERO_BALANCE },
    })));
  }, [supabase, estate, onMsg]);
  useEffect(() => { void load(); }, [load]);

  /* ══════════ 取用 / 補貨 ══════════ */
  const [move, setMove] = useState<
    { row: Row; kind: 'in' | 'out'; qty: string; on: string; note: string } | null>(null);

  async function saveMove() {
    if (!move || busy) return;
    const err = txnError(move.kind, move.qty, move.on);
    if (err) { onMsg(err, true); return; }
    /*
     * ★★ 餘量會變負數時**問一次，不是擋死**。
     *   那多半是打錯，但也可能是真的（先借出去了、補貨忘了登）——
     *   擋死的話那個人記不了帳，而他手上的東西是真的少了。
     */
    const warn = negativeWarn(move.row.bal.balance, move.kind, Number(move.qty));
    if (warn && !confirm(warn)) return;

    setBusy(true);
    try {
      const { data, error } = await supabase.from('supply_txn')
        .insert({
          ...txnRow(move.kind, move.row.id, Number(move.qty), move.on, move.note),
          created_by: profile?.id ?? null,
        }).select('id');
      if (error) { onMsg('記不進去：' + error.message, true); return; }
      if (!data?.length) { onMsg('回成功但沒寫進去 —— 可能是權限', true); return; }
      setMove(null);
      await load();
      onMsg(`${move.row.name} ${KIND_LABEL[move.kind]} ${move.qty}`);
    } finally { setBusy(false); }
  }

  /* ══════════ 月底盤點 ══════════ */
  const [counting, setCounting] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, CountDraft>>({});

  function openCount() {
    setDrafts(Object.fromEntries(rows.map((r) => [r.id, {
      item_id: r.id, system_qty: r.bal.balance, counted: '', reason: '',
    }])));
    setCounting(true);
  }

  async function saveCount() {
    if (busy) return;
    const ds = Object.values(drafts);
    const plan = countPlan(ds, nowYm());
    if (!plan.length) { onMsg('一個都還沒盤', true); return; }
    if (!confirm(countConfirm(ds, nowYm()))) return;

    setBusy(true);
    try {
      /*
       * ★★★ 先寫盤點紀錄、再寫調整流水。順序反過來的話，
       *   中間斷掉會變成「庫存動了但查不到為什麼」——
       *   而那正是盤點要留下的東西。
       *
       * ★ 一個品項一個月只能盤一次（資料庫的 supply_count_uniq），
       *   重盤走 upsert 覆蓋。
       */
      const { data: cs, error: e1 } = await supabase.from('supply_count')
        .upsert(plan.map((p) => ({ ...p.count, counted_by: profile?.id ?? null })),
          { onConflict: 'item_id,ym' })
        .select('id, item_id');
      if (e1) { onMsg('盤點存不進去：' + e1.message, true); return; }
      if ((cs?.length ?? 0) !== plan.length) {
        onMsg(`要存 ${plan.length} 筆，實際只進去 ${cs?.length ?? 0} 筆 —— 先不要再按`, true);
        return;
      }

      const idByItem = Object.fromEntries(
        ((cs ?? []) as { id: string; item_id: string }[]).map((c) => [c.item_id, c.id]));
      const adjs = plan.filter((p) => p.adjust).map((p) => ({
        ...p.adjust!,
        happened_on: today(),
        note: `${nowYm().slice(0, 4)}-${nowYm().slice(4)} 盤點調整`,
        count_id: idByItem[p.count.item_id] ?? null,
        created_by: profile?.id ?? null,
      }));
      if (adjs.length) {
        const { data: td, error: e2 } = await supabase.from('supply_txn').insert(adjs).select('id');
        if (e2) { onMsg('盤點存好了，但調整流水寫不進去：' + e2.message, true); return; }
        if ((td?.length ?? 0) !== adjs.length) {
          onMsg(`盤點存好了，但只寫了 ${td?.length ?? 0}/${adjs.length} 筆調整 —— 餘量還沒對齊`, true);
          return;
        }
      }
      setCounting(false);
      await load();
      onMsg(`盤點完成，產生 ${adjs.length} 筆調整`);
    } finally { setBusy(false); }
  }

  /* ══════════ 新增品項 ══════════ */
  const [add, setAdd] = useState<
    { on: string; name: string; spec: string; vendor: string; expire_on: string; init: string }
    | null>(null);

  async function saveItem() {
    if (!add || busy) return;
    /*
     * ★ 驗證在 `lib/supply-item.ts`,**跟按鈕的 disabled 共用同一支**。
     *   兩份各寫一次遲早會漂,而漂掉的症狀是「按鈕亮著卻送不出去」
     *   或「填好了按鈕還是灰的」—— 兩種都只會讓人覺得系統壞了。
     */
    const bad = newItemError(add);
    if (bad) { onMsg(bad, true); return; }
    setBusy(true);
    try {
      const { data, error } = await supabase.from('supply_item')
        .insert({
          estate_id: estate, name: add.name.trim(),
          spec: add.spec.trim() || null, vendor: add.vendor.trim() || null,
          expire_on: add.expire_on || null, created_by: profile?.id ?? null,
        }).select('id').single();
      /*
       * ★ 撞到唯一鍵要講人話。原文是
       *   「duplicate key value violates unique constraint」，
       *   而填表的人只會覺得系統壞了。
       */
      if (error) {
        onMsg(error.code === '23505'
          ? `這個物業已經有「${add.name.trim()}${add.spec.trim() ? '・' + add.spec.trim() : ''}」了`
          : '建不出來：' + error.message, true);
        return;
      }
      // 初始庫存是一筆 init 流水,不是欄位
      if (needsInitTxn(add.init)) {
        const { error: e2 } = await supabase.from('supply_txn').insert({
          item_id: data!.id, kind: 'init', qty: Number(add.init),
          /*
           * ★★ 用表單填的日期，不是 today()（2026-09-07 使用者:
           *   「表單最上方 必填 日期」）。寫死今天的話,
           *   補建上個月的庫存會整批記到今天,而庫存歷史從此對不上。
           */
          happened_on: add.on, note: '初始庫存', created_by: profile?.id ?? null,
        });
        if (e2) { onMsg('品項建好了，但初始庫存沒寫進去：' + e2.message, true); }
      }
      setAdd(null);
      await load();
      onMsg(`已新增「${add.name.trim()}」`);
    } finally { setBusy(false); }
  }

  /* ══════════════════════════════════════════════════════ */
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select value={estate} onChange={(e) => setEstate(e.target.value)} className={inp}>
          {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <span className="text-xs text-gray-500">{rows.length} 個品項</span>
        <div className="ml-auto flex gap-2">
          {canEditItem && (
            <button onClick={() => setAdd({ on: today(), name: '', spec: '', vendor: '', expire_on: '', init: '' })}
              className="rounded-lg bg-mor-slate text-white px-3 py-1.5 text-xs font-medium hover:bg-mor-slatedark">
              ＋ 新增品項
            </button>
          )}
          <button onClick={openCount} disabled={!rows.length}
            className="rounded-lg border border-mor-slate/50 bg-white text-mor-slate px-3 py-1.5 text-xs font-medium disabled:opacity-40">
            月底盤點
          </button>
        </div>
      </div>

      {loading ? (
        <div className="rounded-xl glass py-10 text-center text-gray-400 text-sm">載入中…</div>
      ) : !rows.length ? (
        <div className="rounded-xl glass py-10 text-center text-gray-400 text-sm">
          這個物業還沒有備品{canEditItem ? '，按右上角新增' : ''}
        </div>
      ) : (
        <div className="rounded-xl glass overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-left">
                <th className="px-3 py-2">物資名稱</th>
                <th className="px-3 py-2">規格型號</th>
                <th className="px-3 py-2 text-right w-16">初始</th>
                <th className="px-3 py-2 text-right w-16">補貨</th>
                <th className="px-3 py-2 text-right w-16">取用</th>
                <th className="px-3 py-2 text-right w-20">餘量</th>
                <th className="px-3 py-2 w-24">廠商</th>
                <th className="px-3 py-2 w-28">效期</th>
                <th className="px-3 py-2 text-right w-40">動作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-mor-line/60">
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{r.spec ?? '—'}</td>
                  <td className="px-3 py-2 text-right text-gray-600">{r.bal.init_qty}</td>
                  <td className="px-3 py-2 text-right text-mor-green">+{r.bal.in_qty}</td>
                  <td className="px-3 py-2 text-right text-red-500">−{r.bal.out_qty}</td>
                  {/* ★★ 餘量是算出來的 —— 這一格永遠不會是輸入框 */}
                  <td className={`px-3 py-2 text-right font-medium ${isLow(r.bal.balance) ? 'text-amber-600' : ''}`}>
                    {r.bal.balance}
                  </td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{r.vendor ?? '—'}</td>
                  <td className={`px-3 py-2 text-xs ${expiringSoon(r.expire_on, today()) ? 'text-amber-700' : 'text-gray-400'}`}>
                    {r.expire_on ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button onClick={() => setMove({ row: r, kind: 'out', qty: '', on: today(), note: '' })}
                      className="rounded-lg border border-mor-line bg-white px-2 py-1 text-xs hover:bg-mor-sand/60">
                      {KIND_BUTTON.out}
                    </button>
                    <button onClick={() => setMove({ row: r, kind: 'in', qty: '', on: today(), note: '' })}
                      className="ml-1 rounded-lg border border-mor-line bg-white px-2 py-1 text-xs hover:bg-mor-sand/60">
                      {KIND_BUTTON.in}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ══════════ 取用 / 補貨 ══════════ */}
      {move && (
        <div className="fixed inset-0 z-40 bg-black/30 flex items-center justify-center p-4"
          onClick={() => setMove(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="font-medium mb-1">{KIND_LABEL[move.kind]}</div>
            <div className="text-xs text-gray-500 mb-3">
              {move.row.name}{move.row.spec ? `・${move.row.spec}` : ''}
            </div>
            <div className="flex flex-col gap-2 text-sm">
              <label className="flex flex-col gap-1">日期
                <input type="date" value={move.on}
                  onChange={(e) => setMove({ ...move, on: e.target.value })} className={inp} /></label>
              <label className="flex flex-col gap-1">數量
                <input type="number" min="0" inputMode="decimal" value={move.qty} placeholder="填正數就好"
                  onChange={(e) => setMove({ ...move, qty: e.target.value })} className={inp} /></label>
              {/* ★ 送出前先算給人看。按下去才知道結果的話，打錯一位數不會被發現 */}
              {move.qty !== '' && Number.isFinite(Number(move.qty)) && (
                <div className="text-xs text-gray-600">
                  目前 {move.row.bal.balance} →{' '}
                  <b className={previewAfter(move.row.bal.balance, move.kind, Number(move.qty)) < 0
                    ? 'text-red-600' : ''}>
                    {previewAfter(move.row.bal.balance, move.kind, Number(move.qty))}
                  </b>
                </div>
              )}
              <label className="flex flex-col gap-1">備註
                <input value={move.note} placeholder="13A5 補貨／好市多"
                  onChange={(e) => setMove({ ...move, note: e.target.value })} className={inp} /></label>
            </div>
            {/* ★★ 講清楚不能刪 —— 按下去之後只能記一筆反向的沖銷 */}
            <div className="mt-2 text-[11px] text-gray-400 leading-relaxed">
              記下去之後不能刪。填錯了就記一筆反向的沖銷。
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => setMove(null)}
                className="flex-1 rounded-lg border border-mor-line px-3 py-1.5 text-sm">取消</button>
              <button onClick={() => void saveMove()} disabled={busy}
                className="flex-1 rounded-lg bg-mor-slate text-white px-3 py-1.5 text-sm font-medium disabled:opacity-40">
                {busy ? '記錄中…' : '確定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════ 月底盤點 ══════════ */}
      {counting && (
        <div className="fixed inset-0 z-40 bg-black/30 flex items-center justify-center p-4"
          onClick={() => setCounting(false)}>
          <div className="w-full max-w-2xl rounded-xl bg-white overflow-hidden"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-mor-line">
              <div className="font-medium">{nowYm().slice(0, 4)}-{nowYm().slice(4)} 盤點</div>
              {/*
                ★★★ 講清楚填的是「實際盤到多少」，不是改餘量。
                  直接改餘量的話「為什麼少了 2 瓶」就消失了 ——
                  而那正是盤點要回答的問題。
              */}
              <div className="text-[11px] text-gray-500 mt-0.5">
                填**實際盤到多少**，差異系統自己算。沒盤的留空 —— 留空不等於 0。
              </div>
            </div>
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50 text-gray-500 text-left">
                  <tr>
                    <th className="px-3 py-2">物資名稱</th>
                    <th className="px-3 py-2 text-right w-20">系統餘量</th>
                    <th className="px-3 py-2 text-right w-24">實際盤到</th>
                    <th className="px-3 py-2 text-right w-16">差異</th>
                    <th className="px-3 py-2 w-40">原因</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const d = drafts[r.id];
                    if (!d) return null;
                    const diff = countDiff(d);
                    return (
                      <tr key={r.id} className="border-t border-mor-line/60">
                        <td className="px-3 py-1.5">{r.name}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{r.bal.balance}</td>
                        <td className="px-3 py-1.5 text-right">
                          <input type="number" inputMode="decimal" value={d.counted}
                            onChange={(e) => setDrafts({ ...drafts, [r.id]: { ...d, counted: e.target.value } })}
                            className="w-20 rounded border border-gray-300 px-1.5 py-0.5 text-right" />
                        </td>
                        <td className={`px-3 py-1.5 text-right ${
                          diff === null ? 'text-gray-300' : diff === 0 ? 'text-gray-500'
                            : diff > 0 ? 'text-mor-green' : 'text-red-500'}`}>
                          {diff === null ? '—' : diff > 0 ? `+${diff}` : diff}
                        </td>
                        <td className="px-3 py-1.5">
                          {/* ★ 對得上的不用填原因 —— 少一個要填的格子 */}
                          {diff !== null && diff !== 0 && (
                            <input value={d.reason ?? ''} placeholder="用掉沒登記／破損"
                              onChange={(e) => setDrafts({ ...drafts, [r.id]: { ...d, reason: e.target.value } })}
                              className="w-full rounded border border-gray-300 px-1.5 py-0.5" />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-mor-line flex gap-2">
              <span className="text-[11px] text-gray-500 self-center">
                盤了 {Object.values(drafts).filter((d) => countDiff(d) !== null).length} / {rows.length} 個
              </span>
              <div className="ml-auto flex gap-2">
                <button onClick={() => setCounting(false)}
                  className="rounded-lg border border-mor-line px-3 py-1.5 text-sm">取消</button>
                <button onClick={() => void saveCount()} disabled={busy}
                  className="rounded-lg bg-mor-slate text-white px-3 py-1.5 text-sm font-medium disabled:opacity-40">
                  {busy ? '送出中…' : '送出盤點'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════ 新增品項 ══════════ */}
      {add && (
        <div className="fixed inset-0 z-40 bg-black/30 flex items-center justify-center p-4"
          onClick={() => setAdd(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="font-medium mb-3">新增品項</div>
            {/*
              ★★★ 每個標籤都用 <span className="flex items-center"> 把文字跟星號包起來。
                外層 label 是 `flex flex-col` —— 直接寫「日期<Req />」的話，
                文字與星號會變成**兩個 flex item**，星號自己掉到下一行
                （2026-09-08 使用者:「* 不要換行」）。
                全站其他表單本來就是這樣寫的，這裡是漏掉的。
            */}
            <div className="flex flex-col gap-2 text-sm">
              {/*
                ★★ 日期放**最上面**（2026-09-07 使用者指定）。它決定初始庫存
                  記在哪一天 —— 擺在最後的話，人填完數量就按建立了。
              */}
              <label className="flex flex-col gap-1"><span className="flex items-center">日期<Req /></span>
                <input type="date" value={add.on}
                  onChange={(e) => setAdd({ ...add, on: e.target.value })} className={inp} /></label>
              <label className="flex flex-col gap-1"><span className="flex items-center">物資名稱<Req /></span>
                <input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })}
                  className={inp} placeholder="衛生紙" /></label>
              <label className="flex flex-col gap-1"><span className="flex items-center">規格型號<Req /></span>
                <input value={add.spec} onChange={(e) => setAdd({ ...add, spec: e.target.value })}
                  className={inp} placeholder="大包裝／12 卷" /></label>
              <label className="flex flex-col gap-1">廠商
                <input value={add.vendor} onChange={(e) => setAdd({ ...add, vendor: e.target.value })}
                  className={inp} placeholder="好市多" /></label>
              <label className="flex flex-col gap-1">效期
                <input type="date" value={add.expire_on}
                  onChange={(e) => setAdd({ ...add, expire_on: e.target.value })} className={inp} /></label>
              {/*
                ★★★ 初始庫存**必填但可以是 0**。「現在沒有」是一個答案,
                  「還沒填」不是 —— 而 `Number('')` 是 0,兩者混在一起的話
                  沒填會被當成填了 0（見 lib/supply-item.ts）。
              */}
              <label className="flex flex-col gap-1"><span className="flex items-center">初始庫存<Req /></span>
                <input type="number" min="0" value={add.init}
                  onChange={(e) => setAdd({ ...add, init: e.target.value })} className={inp} placeholder="沒有就填 0" /></label>
            </div>
            {/* ★ 同物業同名同規格只能一筆 —— 先講，撞到才講就晚了 */}
            <div className="mt-2 text-[11px] text-gray-400 leading-relaxed">
              同一個物業裡，名稱＋規格一樣的只能有一筆。
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => setAdd(null)}
                className="flex-1 rounded-lg border border-mor-line px-3 py-1.5 text-sm">取消</button>
              {/*
                沒填完就鎖住。**但滑鼠移上去要說得出為什麼** ——
                一顆灰掉而不解釋的按鈕，使用者會以為是系統壞了而一直點。
              */}
              <button onClick={() => void saveItem()} disabled={busy || !!newItemError(add)}
                title={newItemError(add) ?? ''}
                className="flex-1 rounded-lg bg-mor-slate text-white px-3 py-1.5 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed">
                {busy ? '建立中…' : '建立'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
