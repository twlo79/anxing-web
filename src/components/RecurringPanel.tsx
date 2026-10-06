'use client';
import { looksLikeError } from '@/lib/flash-kind';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Req from '@/components/Req';
import MoneyInput from '@/components/MoneyInput';
import { fmtInt as fmt } from '@/lib/fmt';
import { missingMessage } from '@/lib/required';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import { DEFAULT_BOOK } from '@/lib/book';
import { FEE_TYPES } from '@/lib/fee-types';
import { ymShow } from '@/lib/period';
import { softDelete } from '@/lib/trash';
import { savedToast, savedText, SAVED_HL, justRow } from '@/lib/saved-feedback';
import { useJustSaved } from '@/lib/use-just-saved';
import { SavedBadge } from '@/components/SavedToast';
import { groupRcByYear, rcYearOpenByDefault, missingYms, defaultEntryYm, entryMissing } from '@/lib/recurring-years';

/**
 * 定期收費面板。**嵌在短租訂單頁裡,不佔側邊選單一格。**
 *
 * ★★ 2026-10-06 起（migration_317）**不再自動產生月份**：月結時「記一筆」選月份、填金額、送出，
 *   營收表當下就有那一筆。下面「設定一次、每月自動長出一列」那段是舊做法的紀錄。
 *
 * 【這在解決什麼】
 * 洗衣機、烘衣機、垃圾代收費這類收入每個月都會發生,以前只能一筆一筆開
 * 「其他收入」。漏掉某個月不會有任何跡象,而且三筆的會計科目都是清潔費,
 * 營收報表按科目分組就併成一格,看不出哪一項在賺。
 *
 * 設定一次,每個月自動長出一列(source='oneoff'、imported_via='recurring')。
 * 產生出來的就是一般訂單,營收報表與 Excel 都照舊吃得到。
 *
 * 【為什麼放這裡而不是獨立一頁】
 * 它跟「其他收入」是同一種東西 —— 差別只在「要不要每個月自動長出來」。
 * 分成兩個頁面會讓人以為那是兩件事,而且側邊選單每多一項,
 * 真正每天要用的功能就被往下擠一格。
 *
 * 【金額為什麼可以逐月改】
 * 垃圾代收費每月固定 5,070,設一次就不用管。
 * 洗衣機是 2,150 / 2,050 / 2,600…,要當月結束才知道。
 * 這個機制保證的是「不會漏掉哪個月」,不是「金額不用填」。
 */

type Rc = {
  id: string;
  estate_id: string; property_id: string | null; property_raw: string | null;
  fee_type: string; item_name: string; amount: number;
  start_ym: string; end_ym: string | null; active: boolean; note: string | null;
};
type Ord = { id: string; order_key: string; checkin: string; amount: number; paid: boolean };
type Estate = { id: string; name: string };
/** 記一筆（2026-10-06 David：「選月份、填金額、送出就好」） */
type Entry = { estate_id: string; property_id: string | null; item: string; fee_type: string; ym: string; amount: number; note: string };
type Property = { id: string; name: string; estate_id: string | null };

const thisYm = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`; };
const thisYear = () => String(new Date().getFullYear());
/** 'RC_<uuid>_202601' → '202601' */
const ymOfKey = (k: string) => k.slice(-6);

export default function RecurringPanel({ canEdit }: { canEdit: boolean }) {
  const supabase = useMemo(() => createClient(), []);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Rc[]>([]);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [orders, setOrders] = useState<Record<string, Ord[]>>({});
  const [loaded, setLoaded] = useState(false);
  /** 記一筆的表單（migration_317）。null ＝ 沒開 */
  const [entry, setEntry] = useState<Entry | null>(null);
  const [expand, setExpand] = useState<string | null>(null);
  /** 年份的開關（'<設定id>:<年>' → 開/關）。沒記錄的用 rcYearOpenByDefault() */
  const [yearOpen, setYearOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const { markSaved, isJust } = useJustSaved(rows);

  function flash(t: string) {
    // ★ 錯誤不自己消失（`looksLikeError`，全站同一套；2026-09-30 體檢）——
    //   RPC 或資料庫丟回來的錯只顯示幾秒的話，使用者看到的是「按了沒反應」。
    setMsg(t);
    if (!looksLikeError(t)) setTimeout(() => setMsg((m) => (m === t ? '' : m)), 4000);
  }

  const load = useCallback(async () => {
    const [rc, es, pr] = await Promise.all([
      supabase.from('recurring_charges').select('*').order('item_name'),
      supabase.from('estates').select('id, name').eq('active', true).order('sort').order('name'),
      supabase.from('properties').select('id, name, estate_id').order('name'),
    ]);
    const list = (rc.data ?? []) as Rc[];
    setRows(list);
    setEstates((es.data ?? []) as Estate[]);
    setProperties((pr.data ?? []) as Property[]);
    if (list.length) {
      /*
       * 定期收費產生的訂單**只增不減**,每個月都在長。
       * 沒有分頁的話總有一天會撞到 Supabase 的 1000 列上限,
       * 而症狀是「舊的收費紀錄不見了」—— 沒有錯誤訊息,只是列表少一截。
       */
      const { rows: od } = await fetchAll<Ord>((f, t) => supabase.from('orders')
        .select('id, order_key, checkin, amount, paid')
        // 只看安幸。`imported_via='recurring'` 目前不可能是別的帳本
        // （愛皮洪鯊沒有房源、沒有定期收費），這一行是保險（migration_159）
        .eq('book', DEFAULT_BOOK)
        .eq('imported_via', 'recurring').order('checkin').range(f, t));
      const m: Record<string, Ord[]> = {};
      for (const o of od) {
        const rid = o.order_key.slice(3, 39);   // 'RC_' + uuid(36)
        (m[rid] ??= []).push(o);
      }
      setOrders(m);
    } else setOrders({});
    setLoaded(true);
  }, [supabase]);
  // 收合時不查資料 —— 這是附屬面板,不該讓每次開短租頁都多兩趟查詢
  useEffect(() => { if (open && !loaded) load(); }, [open, loaded, load]);

  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);

  /** 每筆設定的本月與今年累計。這是「時兆固定有多少額外收入」的答案。 */
  const stat = useCallback((rcId: string) => {
    const os = orders[rcId] ?? [];
    const ym = thisYm(), yr = thisYear();
    return {
      month: os.filter((o) => ymOfKey(o.order_key) === ym).reduce((a, o) => a + Number(o.amount || 0), 0),
      year: os.filter((o) => ymOfKey(o.order_key).startsWith(yr)).reduce((a, o) => a + Number(o.amount || 0), 0),
      n: os.length,
    };
  }, [orders]);

  /** 依物業分組 —— 「時兆固定有這些收入」是以物業為單位在問的 */
  const byEstate = useMemo(() => {
    const g = new Map<string, Rc[]>();
    for (const r of rows) (g.get(r.estate_id) ?? g.set(r.estate_id, []).get(r.estate_id)!).push(r);
    return Array.from(g.entries())
      .map(([eid, list]) => ({
        eid, name: estateName[eid] ?? '—', list,
        month: list.reduce((a, r) => a + stat(r.id).month, 0),
        year: list.reduce((a, r) => a + stat(r.id).year, 0),
      }))
      .sort((a, b) => b.year - a.year);
  }, [rows, estateName, stat]);

  const totalMonth = byEstate.reduce((a, e) => a + e.month, 0);
  const totalYear = byEstate.reduce((a, e) => a + e.year, 0);

  /** 這個設定記過哪幾個月 */
  const recordedOf = useCallback((rcId: string) => (orders[rcId] ?? []).map((o) => ymOfKey(o.order_key)), [orders]);
  /** 表單上打的項目對到哪一筆設定（同物業、同名；房源不管 —— 選了項目就帶它的房源） */
  const matchOf = (e: Entry) => rows.find((r) => r.estate_id === e.estate_id && r.item_name === e.item.trim()) ?? null;

  function openEntry(r?: Rc) {
    setTried(false);
    if (r) {
      setEntry({ estate_id: r.estate_id, property_id: r.property_id, item: r.item_name, fee_type: r.fee_type,
        ym: defaultEntryYm(recordedOf(r.id), thisYm()), amount: 0, note: '' });
    } else {
      setEntry({ estate_id: estates[0]?.id ?? '', property_id: null, item: '', fee_type: '清潔費',
        ym: defaultEntryYm([], thisYm()), amount: 0, note: '' });
    }
  }
  /** 項目改了：對到用過的就帶它的科目、房源、預設月份 */
  function setItem(e: Entry, item: string) {
    const m = rows.find((r) => r.estate_id === e.estate_id && r.item_name === item.trim());
    setEntry(m ? { ...e, item, fee_type: m.fee_type, property_id: m.property_id, ym: defaultEntryYm(recordedOf(m.id), thisYm()) }
               : { ...e, item });
  }

  /** 按過送出了沒 —— 紅框只在他表達「我填完了」之後才出現 */
  const [tried, setTried] = useState(false);
  const missing = entry ? entryMissing(entry) : [];
  const err = (f: string) => tried && missing.includes(f);

  async function submit() {
    if (!entry || busy) return;
    setTried(true);
    if (missing.length) return flash(missingMessage(missing));
    setBusy('save');
    const { data, error } = await supabase.rpc('record_recurring', {
      p_estate: entry.estate_id, p_property: entry.property_id, p_item: entry.item.trim(),
      p_fee_type: entry.fee_type, p_ym: entry.ym, p_amount: entry.amount, p_note: entry.note || null,
    });
    setBusy('');
    if (error) return flash('送出失敗:' + error.message);
    const r = data as { ok: boolean; message: string; rc_id?: string };
    if (!r?.ok) return flash(r?.message ?? '送出失敗');
    setEntry(null); setTried(false);
    if (r.rc_id) { markSaved(r.rc_id); setExpand(r.rc_id); }
    savedToast(r.message);
    load();
  }

  async function del(r: Rc) {
    if (!confirm(
      `刪除定期收費「${r.item_name}」?\n\n`
      + `已記的月份會留在營收表 —— 那是真的收入（migration_317）。\n`
      + `要拿掉某一個月，到短租訂單把那一筆刪掉。\n\n`
      + `會移到回收桶，可以復原。`
    )) return;
    const res = await softDelete(supabase, 'recurring_charges', r.id);
    if (res.ok) { savedToast(savedText('已刪除', r.item_name)); load(); } else flash(res.message);
  }

  async function setAmount(o: Ord, v: number) {
    setOrders((prev) => {
      const next: Record<string, Ord[]> = {};
      for (const [k, list] of Object.entries(prev)) next[k] = list.map((x) => x.id === o.id ? { ...x, amount: v } : x);
      return next;
    });
    const { error } = await supabase.from('orders').update({ amount: v }).eq('id', o.id);
    if (error) { flash('存不進去:' + error.message); load(); }
  }

  return (
    <div className="rounded-xl border border-mor-line bg-white mb-4 overflow-hidden">
      <button onClick={() => setOpen(!open)}
        className="w-full px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-left hover:bg-mor-sand/30">
        <span className="text-sm font-medium">
          <span className="text-gray-400 mr-1">{open ? '▾' : '▸'}</span>
          定期收費
          <span className="ml-2 text-xs font-normal text-gray-500">
            每月結算時記一筆的其他收入（洗衣機、垃圾代收費…）
          </span>
        </span>
        {loaded && rows.length > 0 && (
          <span className="text-xs text-gray-500">
            本月 <span className="font-bold text-gray-700">${fmt(totalMonth)}</span>
            <span className="mx-1.5 text-gray-300">|</span>
            {thisYear()} 年累計 <span className="font-bold text-gray-700">${fmt(totalYear)}</span>
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-mor-line px-4 py-3">
          {msg && <div className="mb-2 rounded-lg bg-mor-greenlight text-mor-green px-3 py-1.5 text-xs">{msg}</div>}
          {canEdit && (
            <div className="flex flex-wrap gap-2 mb-3">
              <button onClick={() => openEntry()}
                className="rounded-lg bg-mor-slate text-white px-3 py-1.5 text-xs font-medium hover:bg-mor-slatedark">＋ 記一筆</button>
            </div>
          )}

          {!loaded ? <div className="py-6 text-center text-gray-400 text-sm">載入中…</div>
            : rows.length === 0 ? (
              <div className="py-6 text-center">
                <div className="text-gray-400 text-sm">還沒有定期收費</div>
                <div className="text-gray-300 text-xs mt-1">洗衣機、垃圾代收費這類每月都會發生的收入適合放這裡</div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* 依物業分組 —— 「時兆固定有這些收入」是以物業為單位在問的 */}
                {byEstate.map((g) => (
                  <div key={g.eid}>
                    <div className="flex items-baseline justify-between px-1 pb-1 border-b border-mor-line/60">
                      <span className="text-sm font-semibold">{g.name}</span>
                      <span className="text-xs text-gray-500">
                        本月 ${fmt(g.month)}<span className="mx-1.5 text-gray-300">|</span>年累計 ${fmt(g.year)}
                      </span>
                    </div>
                    {g.list.map((r) => {
                      const s = stat(r.id);
                      const isOpen = expand === r.id;
                      const os = orders[r.id] ?? [];
                      return (
                        <div key={r.id} className={!r.active ? 'opacity-50' : ''}>
                          <div onClick={() => setExpand(isOpen ? null : r.id)} {...justRow(isJust(r.id))}
                            className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2 text-sm cursor-pointer ${isJust(r.id) ? SAVED_HL : 'hover:bg-mor-sand/30'} border-b border-mor-line/30`}>
                            <span className="text-gray-400 text-xs">{isOpen ? '▾' : '▸'}</span>
                            {isJust(r.id) && <SavedBadge />}
                            <span className="rounded px-1.5 py-0.5 text-[11px] bg-mor-bluelight text-mor-slate">{r.fee_type}</span>
                            <span className="font-medium">{r.item_name}</span>
                            <span className="text-xs text-gray-400">
                              {r.property_raw || '整棟'}
                            </span>
                            <span className="ml-auto text-xs text-gray-500 whitespace-nowrap">
                              本月 <span className="font-medium text-gray-700">${fmt(s.month)}</span>
                              <span className="mx-1.5 text-gray-300">|</span>
                              年累計 <span className="font-medium text-gray-700">${fmt(s.year)}</span>
                              {/* 最後記到的月份之後、到上個月為止沒記的（migration_317；不再先產生 $0 的空月份） */}
                              {(() => { const miss = missingYms(recordedOf(r.id), thisYm());
                                return miss.length > 0 && <span className="text-amber-600 ml-1.5">・缺 {miss.length > 2 ? `${ymShow(miss[0])} 起 ${miss.length} 個月` : miss.map(ymShow).join('、')}</span>; })()}
                            </span>
                            {canEdit && (
                              <span className="flex gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                                <button onClick={() => openEntry(r)} className="text-xs text-mor-slate">記一筆</button>
                                <button onClick={() => del(r)} className="text-xs text-red-500 underline">刪除</button>
                              </span>
                            )}
                          </div>
                          {isOpen && (
                            <div className="px-1 py-2 bg-mor-sand/20">
                              {os.length === 0
                                ? <div className="text-xs text-gray-400 py-2">還沒記任何月份 —— 按右邊的「記一筆」</div>
                                : <div className="space-y-1">
                                    {/* 分年 → 月份（2026-10-06 David 過審）：今年與有未填的年份預設展開 */}
                                    {groupRcByYear(os).map((g) => {
                                      const k = `${r.id}:${g.year}`;
                                      const yo = yearOpen[k] ?? rcYearOpenByDefault(g, thisYear());
                                      return (
                                        <div key={g.year}>
                                          <button onClick={() => setYearOpen((m) => ({ ...m, [k]: !yo }))}
                                            className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-white/70 text-left">
                                            <span className="text-gray-400 text-xs w-3">{yo ? '▾' : '▸'}</span>
                                            <span className="font-medium">{g.year}</span>
                                            <span className="text-xs text-gray-400">{g.list.length} 個月</span>
                                            <span className="ml-auto tabular-nums">${fmt(g.total)}</span>
                                            <span className={`text-xs w-24 text-right ${g.zero ? 'text-amber-600' : 'text-transparent'}`}>
                                              {g.zero ? `・${g.zero} 個月未填` : '—'}</span>
                                          </button>
                                          {yo && (
                                            <div className="flex flex-wrap gap-2 pl-7 pr-1 pt-1 pb-2">
                                              {g.list.map((o) => (
                                      <div key={o.id} className={`rounded-lg border px-2 py-1 ${
                                        o.paid ? 'border-mor-greenlight bg-mor-greenlight/30'
                                          : Number(o.amount) ? 'border-mor-line bg-white' : 'border-amber-300 bg-amber-50/60'}`}>
                                        <div className="text-[11px] text-gray-500">{ymOfKey(o.order_key).slice(4)} 月</div>
                                        <MoneyInput value={Number(o.amount) || 0} placeholder="0"
                                          disabled={!canEdit || o.paid}
                                          onChange={(n) => setAmount(o, n)}
                                          className="w-20 rounded border border-gray-300 px-1 py-0.5 text-sm text-right disabled:bg-gray-100 disabled:text-gray-500" />
                                      </div>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>}
                              <p className="text-[11px] text-gray-400 mt-2">
                                已收款的月份不能改金額 —— 錢收了之後金額是既成事實。要改請先取消收款。
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
        </div>
      )}

      {/* 記一筆（migration_317，2026-10-06 David 過審）：選月份、填金額、送出 —— 營收表當下就有那一筆 */}
      {entry && (() => {
        const m = matchOf(entry);
        const miss = m ? missingYms(recordedOf(m.id), thisYm()) : [];
        const had = m ? (orders[m.id] ?? []).find((o) => ymOfKey(o.order_key) === entry.ym) : undefined;
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={busy ? undefined : () => setEntry(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[88vh] overflow-y-auto">
            <div className="sticky top-0 z-10 bg-white border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between">
              記一筆定期收費
              <button onClick={() => setEntry(null)} disabled={!!busy} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="px-6 py-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <label className="flex flex-col gap-1"><span className="flex items-center">物業<Req /></span>
                <select value={entry.estate_id}
                  onChange={(e) => setItem({ ...entry, estate_id: e.target.value, property_id: null }, entry.item)}
                  className={`rounded-lg border px-2 py-1.5 ${err('物業') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}>
                  {estates.map((es) => <option key={es.id} value={es.id}>{es.name}</option>)}
                </select></label>
              {/* 留白 = 整棟。垃圾代收、公區清潔本來就不屬於某一間房。 */}
              <label className="flex flex-col gap-1">房源
                <select value={entry.property_id ?? ''} onChange={(e) => setEntry({ ...entry, property_id: e.target.value || null })}
                  className="rounded-lg border border-gray-300 px-2 py-1.5">
                  <option value="">整棟（不指定房源）</option>
                  {properties.filter((x) => x.estate_id === entry.estate_id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select></label>
              {/* 自由輸入但提示用過的 —— 「洗衣機」跟「洗衣機費」會變成報表上兩列 */}
              <label className="flex flex-col gap-1"><span className="flex items-center">項目<Req /></span>
                <input list="rc-items" value={entry.item} placeholder="洗衣機"
                  onChange={(e) => setItem(entry, e.target.value)}
                  className={`rounded-lg border px-2 py-1.5 ${err('項目') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                <datalist id="rc-items">
                  {rows.filter((r) => r.estate_id === entry.estate_id).map((r) => <option key={r.id} value={r.item_name} />)}
                </datalist>
                <span className="text-[11px] text-gray-400">{m ? '用過的項目，科目與房源已帶入' : entry.item.trim() ? '新項目 —— 送出後就會出現在清單' : '選用過的；打新的就是新項目'}</span>
              </label>
              <label className="flex flex-col gap-1">會計科目
                <select value={entry.fee_type} onChange={(e) => setEntry({ ...entry, fee_type: e.target.value })}
                  className="rounded-lg border border-gray-300 px-2 py-1.5">
                  {FEE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select></label>
              <label className="flex flex-col gap-1"><span className="flex items-center">月份<Req /></span>
                <input type="month" value={entry.ym ? `${entry.ym.slice(0, 4)}-${entry.ym.slice(4)}` : ''}
                  onChange={(e) => setEntry({ ...entry, ym: e.target.value.replace('-', '') })}
                  className={`rounded-lg border px-2 py-1.5 ${err('月份') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                {had ? <span className="text-[11px] text-amber-700">這個月已記 ${fmt(Number(had.amount) || 0)}，送出會改成新的金額</span>
                  : miss.length > 0 ? <span className="text-[11px] text-amber-700">{entry.item.trim()} 還缺 {miss.map(ymShow).join('、')}</span>
                  : <span className="text-[11px] text-gray-400">記在這個月的最後一天</span>}
              </label>
              <label className="flex flex-col gap-1"><span className="flex items-center">收入金額<Req /></span>
                <MoneyInput value={entry.amount || 0} placeholder="0"
                  onChange={(n) => setEntry({ ...entry, amount: n })}
                  className={`rounded-lg border px-2 py-1.5 text-right ${err('收入金額') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} /></label>
              <label className="flex flex-col gap-1 col-span-1 md:col-span-2">備註
                <input value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })}
                  className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              {msg && looksLikeError(msg) && <div className="col-span-1 md:col-span-2 text-xs text-red-600">{msg}</div>}
            </div>
            <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3 flex justify-end gap-2">
              <button onClick={() => setEntry(null)} disabled={!!busy} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={submit} disabled={!!busy}
                className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
                {busy === 'save' ? '送出中…' : '送出'}</button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}
