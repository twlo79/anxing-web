'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useOnce } from '@/lib/once';
import Req from '@/components/Req';
import MoneyInput from '@/components/MoneyInput';
import { busyOfOrder, busyOfContract, roomFree, type Busy } from '@/lib/room-free';
import { lockedMsg, type Ym } from '@/lib/period-lock';
import {
  occupiedRange, lengthOf, lengthText, draftError, orderInsert, contractInsert, addDays,
  type BookingDraft, type BookingKind,
} from '@/lib/quick-booking';
import type { MoveRoom } from './move-panel';

/*
 * ══════════════════════════════════════════════════════════
 * 房源狀態「＋ 加訂單」（2026-10-13 David 過審）
 *
 *   1 私下訂單／契約　2 姓名　3 起訖 *　4 物業 *　5 房源 *　6 價格　7 備註
 *
 *   桌機右側抽屜、手機底部抽屜（跟移房面板同一個樣子）。
 *   點日曆空白格子進來的，帶入那間房與那一天。
 *
 * ★★ 欄位與預設值在 lib/quick-booking.ts（有測試）——
 *   跟訂單頁新增私下訂單、契約頁新增契約寫進去的一樣。
 * ★ 那段有人住的房選不了（送出前再查一次，資料庫的關帳守衛照舊）。
 * ══════════════════════════════════════════════════════════
 */

export type Created = { kind: BookingKind; id: string; room: string };

export default function AddBookingPanel({ sheet, rooms, init, onClose, onDone }: {
  sheet: boolean;
  rooms: readonly MoveRoom[];
  /** 點空白格子帶進來的；按右上按鈕進來的只帶物業 */
  init: { estateId: string | null; propertyId?: string | null; day?: string | null };
  onClose: () => void;
  onDone: (c: Created) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const estates = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rooms) if (r.estate_id) m.set(r.estate_id, r.estate);
    return [...m].map(([id, name]) => ({ id, name }));
  }, [rooms]);

  const day0 = init.day || new Date().toISOString().slice(0, 10);
  const initRoom = rooms.find((r) => r.id === init.propertyId);
  const [d, setD] = useState<BookingDraft>({
    kind: 'private', name: '', from: day0, to: addDays(day0, 1),
    estateId: initRoom?.estate_id ?? init.estateId ?? estates[0]?.id ?? null,
    propertyId: initRoom?.id ?? null, room: initRoom?.name ?? '', price: null, note: '',
  });
  const set = (p: Partial<BookingDraft>) => setD((x) => ({ ...x, ...p }));
  /*
   * 切種類：私下預設住一晚、契約預設半年（最後一天＝起日＋6 個月−1 天）。
   * ★ 只在使用者還沒改過迄日時才換 —— 改過的不要蓋掉。
   */
  const toTouched = useRef(false);
  const setKind = (k: BookingKind) => setD((x) => {
    if (toTouched.current || x.kind === k) return { ...x, kind: k };
    if (k === 'contract') {
      const [y, m, dd] = x.from.split('-').map(Number);
      const end = new Date(Date.UTC(y, m - 1 + 6, dd) - 86400000).toISOString().slice(0, 10);
      return { ...x, kind: k, to: end };
    }
    return { ...x, kind: k, to: addDays(x.from, 1) };
  });

  /* 這段誰佔著哪間房（換日子才重查） */
  const range = occupiedRange(d);
  const [busy, setBusy] = useState<Busy[] | null>(null);
  useEffect(() => {
    if (!range) { setBusy([]); return; }
    let alive = true;
    setBusy(null);
    const t = setTimeout(async () => {
      const [{ data: os }, { data: cs }] = await Promise.all([
        supabase.from('orders').select('property_id, estate_id, property_raw, checkin, checkout')
          .not('source', 'in', '(oneoff,airbnb_cancelled)').is('cancelled_on', null)
          .lt('checkin', range.to).gt('checkout', range.from),
        /* ★ contracts 沒有 property_id 欄（2026-10-13 查到）—— 帶了整支查詢會失敗、契約全被當成空房。用物業＋房號比 */
      supabase.from('contracts').select('estate_id, room, start_date, end_date, active')
          .lt('start_date', range.to).gte('end_date', range.from),
      ]);
      if (!alive) return;
      const b: Busy[] = [];
      for (const x of (os ?? []) as any[]) { const y = busyOfOrder(x); if (y) b.push(y); }
      for (const c of (cs ?? []) as any[]) { if (c.active === false) continue; const y = busyOfContract(c); if (y) b.push(y); }
      setBusy(b);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [supabase, range?.from, range?.to]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 關帳的月份（私下訂單送出前先講；資料庫守衛才是真的擋） */
  const [locked, setLocked] = useState<Ym[]>([]);
  useEffect(() => {
    supabase.from('period_lock').select('ym').eq('locked', true)
      .then(({ data }) => setLocked(((data ?? []) as { ym: string }[]).map((r) => r.ym as Ym)));
  }, [supabase]);

  const err = draftError(d, busy);
  const lockErr = d.kind === 'private' && range
    ? lockedMsg({ checkin: d.from, checkout: d.to, imported_via: 'manual' }, locked) : null;
  const [saveErr, setSaveErr] = useState('');
  /** 按過一次送出之後才畫紅框（星號一開始就有，紅框是「你漏了」） */
  const [tried, setTried] = useState(false);
  const bad = (k: 'date' | 'estate' | 'room' | 'price') => tried && (
    k === 'date' ? !range : k === 'estate' ? !d.estateId : k === 'room' ? !d.room
      : d.kind === 'contract' && !(Number(d.price) > 0));

  const [save, saving] = useOnce(async () => {
    setTried(true); setSaveErr('');
    if (err) return;
    if (lockErr) { setSaveErr(lockErr); return; }
    if (d.kind === 'private') {
      const { data, error } = await supabase.from('orders').insert(orderInsert(d)).select('id').single();
      if (error || !data) { setSaveErr('建立失敗：' + (error?.message ?? '')); return; }
      onDone({ kind: 'private', id: (data as any).id, room: d.room });
    } else {
      const { data, error } = await supabase.from('contracts').insert(contractInsert(d)).select('id').single();
      if (error || !data) { setSaveErr('建立失敗：' + (error?.message ?? '')); return; }
      onDone({ kind: 'contract', id: (data as any).id, room: d.room });
    }
  });

  const isP = d.kind === 'private';
  const opts = rooms.filter((r) => r.estate_id === d.estateId);
  const freeOf = (r: MoveRoom) => !busy || !range || roomFree(busy, r, range.from, range.to);
  const n = lengthOf(d);
  const y0 = useRef<number | null>(null);
  /*
   * ★ 2026-10-13 David：「右邊抽屜很怪，可以在中間嗎，然後不要有空」——
   *   桌機改成置中視窗、高度跟著內容（最多 90vh 再捲）；手機照舊從底部出來，也是跟著內容高。
   */
  const box = sheet
    ? 'fixed inset-x-0 bottom-0 max-h-[90vh] rounded-t-2xl'
    : 'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[calc(100vw-2rem)] max-h-[90vh] rounded-2xl';
  const inp = (b: boolean) => `h-10 w-full rounded-lg border px-2 text-ui bg-white ${b ? 'border-red-400 bg-red-50' : 'border-gray-300'}`;
  const lab = 'flex items-center text-uisub text-gray-500';

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label={isP ? '加私下訂單' : '加契約'}
        className={`${box} z-50 bg-white shadow-2xl flex flex-col`}>
        {sheet && (
          <div className="pt-2 pb-1 shrink-0 touch-none"
            onPointerDown={(e) => { y0.current = e.clientY; }}
            onPointerUp={(e) => { if (y0.current != null && e.clientY - y0.current > 60) onClose(); y0.current = null; }}>
            <i className="block mx-auto w-10 h-1.5 rounded-full bg-mor-line" />
          </div>
        )}
        <div className="min-h-0 shrink overflow-y-auto px-4 pb-3 pt-2 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-base font-bold">{isP ? '加私下訂單' : '加契約'}</span>
            <button onClick={onClose} aria-label="關閉"
              className="w-8 h-8 rounded-full bg-mor-bg text-gray-500 text-base leading-none">✕</button>
          </div>

          {/* 1 種類 */}
          <div className="flex rounded-lg bg-mor-sand p-1">
            {([['private', '私下訂單', 'bg-mor-green'], ['contract', '契約', 'bg-mor-slate']] as const).map(([k, t, sw]) => (
              <button key={k} type="button" onClick={() => setKind(k)}
                className={`flex-1 rounded-md py-2 text-sm inline-flex items-center justify-center gap-1.5 ${
                  d.kind === k ? 'bg-white font-semibold shadow-sm' : 'text-gray-600'}`}>
                <i className={`w-2.5 h-2.5 rounded-sm ${sw}`} />{t}
              </button>
            ))}
          </div>

          {/* 2 姓名 */}
          <label className="flex flex-col gap-1">
            <span className={lab}>{isP ? '姓名' : '承租人'}</span>
            <input value={d.name} onChange={(e) => set({ name: e.target.value })}
              placeholder={isP ? '房客姓名' : '承租人姓名'} className={inp(false)} />
          </label>

          {/* 3 起訖 */}
          <div className="flex flex-col gap-1">
            <span className={lab}>{isP ? '住宿起訖' : '租期起訖'}<Req /></span>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-0.5 text-[11px] text-gray-400">{isP ? '入住日' : '起租日'}
                <input type="date" value={d.from} onChange={(e) => set({ from: e.target.value })} className={inp(bad('date'))} />
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-gray-400">{isP ? '退房日' : '最後一天（含）'}
                <input type="date" value={d.to} min={d.from}
                  onChange={(e) => { toTouched.current = true; set({ to: e.target.value }); }} className={inp(bad('date'))} />
              </label>
            </div>
            {n > 0 && <div className="text-xs text-mor-slate">{lengthText(d)}</div>}
          </div>

          {/* 4 物業 */}
          <label className="flex flex-col gap-1">
            <span className={lab}>物業<Req /></span>
            <select value={d.estateId ?? ''} onChange={(e) => set({ estateId: e.target.value || null, propertyId: null, room: '' })}
              className={inp(bad('estate'))}>
              <option value="">選物業</option>
              {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>

          {/* 5 房源 */}
          <label className="flex flex-col gap-1">
            <span className={lab}>房源<Req /></span>
            <select value={d.propertyId ?? ''} className={inp(bad('room'))}
              onChange={(e) => { const r = rooms.find((x) => x.id === e.target.value); set({ propertyId: r?.id ?? null, room: r?.name ?? '' }); }}>
              <option value="">{busy ? '選房源' : '選房源（查空房中⋯）'}</option>
              {opts.map((r) => <option key={r.id} value={r.id}>{r.name}{freeOf(r) ? '' : '（這段有人）'}</option>)}
            </select>
          </label>

          {/* 6 價格 */}
          <div className="flex flex-col gap-1">
            <span className={lab}>{isP ? '價格（整筆）' : '月租金'}{!isP && <Req />}</span>
            <MoneyInput value={d.price ?? 0} onChange={(v) => set({ price: v > 0 ? v : null })} invalid={bad('price')}
              className="h-10 w-full rounded-lg border border-gray-300 px-2 text-right text-ui bg-white" />
            <div className="text-[11px] text-gray-400">
              {isP
                ? (Number(d.price) > 0 && n > 0 ? `平均每晚 NT$ ${Math.round(Number(d.price) / n).toLocaleString()}` : '可以先空著，之後到訂單頁補（空著＝營收 0）')
                : (Number(d.price) > 0 ? `月繳・每期 NT$ ${Number(d.price).toLocaleString()}` : '月繳，每月自動產生月租單')}
            </div>
          </div>

          {/* 7 備註 */}
          <label className="flex flex-col gap-1">
            <span className={lab}>備註</span>
            <textarea value={d.note} onChange={(e) => set({ note: e.target.value })} rows={2}
              placeholder="例：朋友介紹、晚到" className="rounded-lg border border-gray-300 px-2 py-1.5 text-ui" />
          </label>

          <div className="text-[11px] text-gray-400 leading-relaxed">
            {isP ? '押金、訂金、發票之後到訂單頁補 —— 這裡先把房佔起來、記一筆營收。'
                 : '月繳、長租。押金、付款日、發票、固定加費之後到契約頁補。'}
          </div>
          {/* 錯誤留在面板裡（anxing-ui 二-5）。按過送出才講缺什麼；有人住、關帳一律直接講 */}
          {(saveErr || lockErr || (err && (tried || err.includes('有人住')))) && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{saveErr || lockErr || err}</div>
          )}
        </div>
        <div className="shrink-0 flex gap-2 border-t border-mor-line px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button onClick={onClose} className="flex-1 h-12 rounded-xl border border-mor-line text-sm">取消</button>
          <button onClick={save} disabled={saving || (tried && !!err) || !!lockErr} title={err ?? lockErr ?? undefined}
            className="flex-1 h-12 rounded-xl bg-mor-slate text-white text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
            {saving ? '建立中⋯' : isP ? '建立訂單' : '建立契約'}
          </button>
        </div>
      </div>
    </>
  );
}
