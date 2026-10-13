'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useOnce } from '@/lib/once';
import { roomFree, nightsLabel, dayBefore, type RoomRef } from '@/lib/room-free';
import {
  moveSegments, moveError, moveChain, wholeMove, splitMove, canQuickMove, splitDays, moveCandidates,
  type MoveState, type MoveStay,
} from '@/lib/order-move';
import { loadMove, commitMove } from '@/lib/order-move-io';

/*
 * ══════════════════════════════════════════════════════════
 * 移房面板 —— 訂單頁與房源狀態頁共用（2026-10-12 David 過審）
 *
 *   桌機　右側抽屜　　手機　底部抽屜（85%）
 *
 *   三個分頁（David：「需要三個」）：
 *     1 整段移　整筆換到另一間（只列同物業、整段都空的）
 *     2 部分移　切兩段：選哪天起換 → 後面那段找空房 → 移（同物業）
 *     3 手動移　自由移：每段自己選物業、房源、移入日，可以切三段以上、可以跨物業
 *
 * ★★★ 算法與寫入**只有一份**（lib/order-move.ts、order-move-io.ts）——
 *   金額照晚數拆、移房鏈、備註追加、收款紀錄會刪時先問、整批走 move_order RPC。
 *
 * ★ 已經分成兩段以上的單，1、2 不能用（它們是從「一段」出發的），直接開在 3 手動移。
 * ══════════════════════════════════════════════════════════
 */

export type MoveRoom = RoomRef & { estate: string };
type Tab = 'whole' | 'split' | 'manual';
const TABS: [Tab, string][] = [['whole', '1 整段移'], ['split', '2 部分移'], ['manual', '3 手動移']];

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export default function MovePanel({ srcId, sheet, rooms: roomsIn, onClose, onDone }: {
  srcId: string; sheet: boolean;
  /** 可以移到哪些房。沒給就自己撈（訂單頁用）—— 規則跟房源狀態一樣：在用、勾排房表、物業在用 */
  rooms?: readonly MoveRoom[];
  onClose: () => void; onDone: (message: string) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [roomsOwn, setRoomsOwn] = useState<MoveRoom[]>([]);
  useEffect(() => {
    if (roomsIn) return;
    let alive = true;
    Promise.all([
      supabase.from('estates').select('id, name, active'),
      supabase.from('properties').select('id, name, estate_id, show_in_room_calendar').eq('active', true),
    ]).then(([{ data: es }, { data: ps }]) => {
      if (!alive) return;
      const est = new Map(((es ?? []) as any[]).filter((e) => e.active).map((e) => [e.id as string, e.name as string]));
      setRoomsOwn(((ps ?? []) as any[])
        .filter((p) => p.estate_id && est.has(p.estate_id) && p.show_in_room_calendar !== false)
        .map((p) => ({ id: p.id, name: p.name, estate_id: p.estate_id, estate: est.get(p.estate_id)! })));
    });
    return () => { alive = false; };
  }, [supabase, roomsIn]);
  const rooms = roomsIn ?? roomsOwn;
  /** 手動移的物業下拉（照房源清單裡出現的物業） */
  const estates = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rooms) if (r.estate_id) m.set(r.estate_id, r.estate);
    return [...m].map(([id, name]) => ({ id, name }));
  }, [rooms]);

  const [m, setM] = useState<MoveState | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [tab, setTab] = useState<Tab>('whole');
  const [day, setDay] = useState('');
  const [pickId, setPickId] = useState('');
  /** 手動移編輯中的各段；null ＝ 還沒動過（＝ 目前的樣子） */
  const [man, setMan] = useState<MoveStay[] | null>(null);
  const [err, setErr] = useState('');
  const y0 = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    loadMove(supabase, srcId).then((x) => {
      if (!alive) return;
      if (!x) { setLoadErr('讀不到這筆訂單（可能是訂金階段還沒定日期）'); return; }
      setM(x); setDay(splitDays(x)[0] ?? '');
      if (!canQuickMove(x)) setTab('manual');
    });
    return () => { alive = false; };
  }, [supabase, srcId]);

  const quick = !!m && canQuickMove(m);
  const self = m?.stays[0];
  const selfRoom = self ? rooms.find((r) => r.id === self.propertyId)
    ?? rooms.find((r) => r.name === self.room && (!self.estateId || r.estate_id === self.estateId)) : undefined;
  const from = tab === 'whole' ? m?.checkin ?? '' : day;
  const cands = useMemo(() => (m?.busy && tab !== 'manual'
    ? moveCandidates(m.busy, rooms, from, m.checkout, selfRoom?.id ?? null, self?.estateId ?? null)
    : { free: [], partly: [] }), [m, rooms, from, selfRoom, self, tab]);

  const target = rooms.find((r) => r.id === pickId);
  /* 要送出去的樣子：1、2 選了房才有；3 動過才有 */
  const next: MoveState | null = !m ? null
    : tab === 'manual' ? (man ? { ...m, stays: man } : null)
    : target ? (tab === 'whole' ? wholeMove(m, target) : splitMove(m, day, target)) : null;
  /* 換分頁或換日子時，已選的房不在新清單裡就取消選取 */
  useEffect(() => { if (pickId && !cands.free.some((r) => r.id === pickId)) setPickId(''); }, [cands, pickId]);
  const segs = next ? moveSegments(next) : [];
  const blocked = next ? moveError(next) : null;

  /* 手動移的編輯 */
  const manStays = man ?? m?.stays ?? [];
  const manSegs = m ? moveSegments({ ...m, stays: manStays }) : [];
  const setStay = (i: number, patch: Partial<MoveStay>) => setMan(manStays.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const addStay = () => setMan([...manStays, {
    room: '', estateId: manStays[manStays.length - 1]?.estateId ?? null, propertyId: null, from: '',
  }]);
  const delStay = (i: number) => setMan(manStays.filter((_, k) => k !== i));

  const [save, saving] = useOnce(async () => {
    if (!next) return;
    setErr('');
    const r = await commitMove(supabase, next, (t) => window.confirm(t));
    if (r.cancelled) return;
    if (!r.ok) { setErr(r.message); return; }
    onDone(r.message);
  });

  const box = sheet
    ? 'fixed inset-x-0 bottom-0 h-[85vh] rounded-t-2xl'
    : 'fixed top-0 right-0 h-full w-[420px] max-w-full border-l border-mor-line';
  const why = !next ? (tab === 'manual' ? '先改房源或日期' : '先選一間房') : blocked ?? undefined;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="移房"
        className={`${box} z-50 bg-white shadow-2xl flex flex-col`}>
        {sheet && (
          <div className="pt-2 pb-1 shrink-0 touch-none"
            onPointerDown={(e) => { y0.current = e.clientY; }}
            onPointerUp={(e) => { if (y0.current != null && e.clientY - y0.current > 60) onClose(); y0.current = null; }}>
            <i className="block mx-auto w-10 h-1.5 rounded-full bg-mor-line" />
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-4 pb-3 pt-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-base font-bold">移房</span>
            <button onClick={onClose} aria-label="關閉"
              className="w-8 h-8 rounded-full bg-mor-bg text-gray-500 text-base leading-none">✕</button>
          </div>

          {loadErr && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{loadErr}</div>}
          {!m && !loadErr && <div className="py-8 text-center text-sm text-gray-400">讀取中⋯</div>}

          {m && (
            <>
              <div className="rounded-xl border border-mor-line bg-[#FAFAF9] p-3 text-sm">
                <div className="font-semibold">{m.guest || '（沒有名字）'}</div>
                <div className="mt-0.5 text-xs text-gray-500 tabular-nums">
                  現在 <b className="text-mor-ink">{m.origRooms.join(' → ') || '—'}</b>・
                  {md(m.checkin)} ～ {md(dayBefore(m.checkout))}（最後一晚）・{m.totalNights} 晚・
                  NT$ {m.totalAmount.toLocaleString()}
                </div>
              </div>

              <div className="mt-3 flex rounded-lg bg-mor-sand p-1">
                {TABS.map(([k, t]) => {
                  const off = k !== 'manual' && (!quick || (k === 'split' && !splitDays(m).length));
                  return (
                    <button key={k} onClick={() => { setTab(k); setErr(''); }} disabled={off}
                      title={off ? (!quick ? '這筆已經分成好幾段，用「手動移」' : '只住一晚，沒有中途可以換') : undefined}
                      className={`flex-1 rounded-md py-2 text-sm disabled:opacity-40 ${
                        tab === k ? 'bg-white font-semibold shadow-sm' : 'text-gray-600'}`}>{t}</button>
                  );
                })}
              </div>
              {!quick && (
                <div className="mt-2 text-[11px] text-gray-500">這筆已經分成 {m.stays.length} 段，只能用「手動移」一起調整。</div>
              )}

              {/* ── 1 整段移 ／ 2 部分移：同物業找空房 ── */}
              {tab !== 'manual' && (
                <>
                  {tab === 'split' && (() => {
                    /*
                     * ★ 2026-10-13 David：「沒說清楚哪天開始算第二間」——
                     *   下拉寫「第 2 間從哪一晚開始住」，底下把兩段攤開：哪幾晚住哪一間、各幾晚。
                     */
                    const n1 = day ? Math.round((new Date(day).getTime() - new Date(m.checkin).getTime()) / 86400000) : 0;
                    const n2 = m.totalNights - n1;
                    return (
                      <div className="mt-3">
                        <label className="flex flex-col gap-1 text-sm">
                          <span className="text-gray-500">第 2 間從哪一晚開始住</span>
                          <select value={day} onChange={(e) => setDay(e.target.value)}
                            className="h-10 rounded-lg border border-gray-300 px-2 text-ui">
                            {splitDays(m).map((d) => {
                              const k = Math.round((new Date(d).getTime() - new Date(m.checkin).getTime()) / 86400000);
                              return <option key={d} value={d}>{md(d)} 那一晚起住第 2 間（第 1 間住 {k} 晚）</option>;
                            })}
                          </select>
                        </label>
                        {day && (
                          <div className="mt-2 rounded-lg bg-mor-bg px-3 py-2 text-xs tabular-nums space-y-0.5">
                            <div className="flex gap-2">
                              <span className="text-gray-500 w-12 shrink-0">第 1 間</span>
                              <b className="min-w-[3rem]">{m.stays[0].room}</b>
                              <span>{md(m.checkin)} ～ {md(dayBefore(day))}・{n1} 晚</span>
                            </div>
                            <div className="flex gap-2">
                              <span className="text-gray-500 w-12 shrink-0">第 2 間</span>
                              <b className={`min-w-[3rem] ${target ? '' : 'font-normal text-gray-400'}`}>{target?.name ?? '下面選'}</b>
                              <span>{md(day)} ～ {md(dayBefore(m.checkout))}・{n2} 晚</span>
                            </div>
                            <div className="text-[11px] text-gray-400">{md(day)} 當天從 {m.stays[0].room} 退房、搬進第 2 間</div>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  <div className="mt-3 mb-1.5 text-[11px] text-gray-400">
                    {tab === 'split' ? '第 2 間：' : ''}只列{selfRoom ? ` ${selfRoom.estate} ` : '同物業'}
                    {from ? nightsLabel(from, m.checkout) : '—'} 每一晚都空的房源（不跨物業）
                  </div>
                  {!m.busy && <div className="py-4 text-center text-xs text-gray-400">查空房中⋯</div>}
                  {m.busy && cands.free.length === 0 && (
                    <div className="rounded-lg bg-mor-bg px-3 py-3 text-center text-xs text-gray-500">
                      同物業這段期間沒有整段都空的房源 —— 可以試「{tab === 'whole' ? '2 部分移' : '3 手動移'}」
                    </div>
                  )}
                  <div className="space-y-1.5">
                    {cands.free.map((r) => (
                      <button key={r.id} onClick={() => setPickId(r.id)}
                        className={`w-full flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left ${
                          pickId === r.id ? 'border-mor-slate bg-mor-bluelight' : 'border-mor-line bg-white hover:bg-mor-bg'}`}>
                        <b className="min-w-[3.5rem] text-sm">{r.name}</b>
                        <span className="flex-1" />
                        <span className="rounded bg-mor-greenlight px-1.5 text-[11px] text-mor-greendark">整段空</span>
                      </button>
                    ))}
                  </div>
                  {cands.partly.length > 0 && (
                    <>
                      <div className="mt-4 mb-1.5 flex items-center gap-2 text-[11px] font-bold text-gray-500">
                        只有部分晚數空<i className="flex-1 h-px bg-mor-line" />
                      </div>
                      <div className="space-y-1.5">
                        {cands.partly.map(({ room: r, busyNights }) => (
                          <div key={r.id} className="flex items-center gap-2 rounded-xl border border-mor-line px-3 py-2.5 opacity-50">
                            <b className="min-w-[3.5rem] text-sm">{r.name}</b>
                            <span className="flex-1 text-xs text-gray-500">
                              {busyNights} 晚有人{tab === 'whole' ? ' —— 改用「2 部分移」' : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}

              {/* ── 3 手動移：每段自己選，可以切三段以上、可以跨物業 ── */}
              {tab === 'manual' && (
                <div className="mt-3 space-y-2">
                  <div className="text-[11px] text-gray-400">每一段自己選物業、房源、從哪天住進去。房源下拉只列那一段每晚都空的（目前選的那間除外）。</div>
                  {manStays.map((s, i) => {
                    const sg = manSegs[i];
                    const opts = rooms.filter((r) => r.estate_id === s.estateId);
                    const freeOf = (r: MoveRoom) => !m.busy || !sg || roomFree(m.busy, r, sg.from, sg.to);
                    return (
                      <div key={i} className="rounded-xl border border-mor-line bg-[#FAFAF9] p-3">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium">第 {i + 1} 段{i === 0 ? '（入住）' : ''}</span>
                          {i > 0 && (
                            <button type="button" onClick={() => delStay(i)}
                              className="text-xs text-red-400 underline hover:text-red-600">刪除這段</button>
                          )}
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <select value={s.estateId ?? ''} aria-label="物業"
                            onChange={(e) => setStay(i, { estateId: e.target.value || null, room: '', propertyId: null })}
                            className="h-10 rounded-lg border border-gray-300 px-2 text-sm bg-white">
                            <option value="">物業</option>
                            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                          </select>
                          <select value={s.propertyId ?? ''} aria-label="房源"
                            onChange={(e) => {
                              const r = rooms.find((x) => x.id === e.target.value);
                              setStay(i, { room: r?.name ?? '', propertyId: r?.id ?? null });
                            }}
                            className="h-10 rounded-lg border border-gray-300 px-2 text-sm bg-white">
                            <option value="">{s.room && !s.propertyId ? s.room : '房源'}</option>
                            {opts.filter((r) => r.id === s.propertyId || freeOf(r)).map((r) => (
                              <option key={r.id} value={r.id}>{r.name}{freeOf(r) ? '' : '（有人）'}</option>
                            ))}
                          </select>
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                          {i === 0 ? <span>入住日 {m.checkin}</span> : (
                            <label className="flex items-center gap-1.5">移入日
                              <input type="date" value={s.from} min={m.checkin} max={m.checkout}
                                onChange={(e) => setStay(i, { from: e.target.value })}
                                className="h-9 rounded-lg border border-gray-300 px-2 text-sm bg-white" />
                            </label>
                          )}
                          {sg && sg.nights > 0 && (
                            <span className="ml-auto tabular-nums">{nightsLabel(sg.from, sg.to)}・{sg.nights} 晚</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <button type="button" onClick={addStay}
                    className="text-sm font-medium text-mor-slate hover:text-mor-slatedark">＋ 再切一段</button>
                </div>
              )}

              {next && !blocked && (
                <div className="mt-4 rounded-xl border border-mor-line p-3 text-xs">
                  <div className="mb-1.5 font-bold text-gray-500">移完之後</div>
                  {segs.map((sg, i) => (
                    <div key={i} className="flex items-baseline gap-2 tabular-nums">
                      <b className="text-sm text-mor-ink min-w-[3.5rem]">{sg.room}</b>
                      <span className="text-gray-500">{nightsLabel(sg.from, sg.to)}・{sg.nights} 晚</span>
                      <span className="ml-auto">NT$ {sg.amount.toLocaleString()}</span>
                    </div>
                  ))}
                  <div className="mt-1.5 text-[11px] text-gray-400 leading-relaxed">
                    {segs.length > 1 ? '金額照晚數拆，押金留在第 1 段。' : '不拆段，金額不變。'}
                    {moveChain(m.origRooms, segs.map((x) => x.room)).length > 1
                      ? `備註會加一行「移房 ${moveChain(m.origRooms, segs.map((x) => x.room)).join('>')}」，原本的備註留著。`
                      : '房號沒有變，不會動到備註。'}
                  </div>
                </div>
              )}
              {(err || blocked) && <div className="mt-2 text-xs text-red-600">{err || blocked}</div>}
            </>
          )}
        </div>
        <div className="shrink-0 flex gap-2 border-t border-mor-line px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button onClick={onClose} className="flex-1 h-12 rounded-xl border border-mor-line text-sm">取消</button>
          <button onClick={save} disabled={!next || !!blocked || saving} title={why}
            className="flex-1 h-12 rounded-xl bg-mor-slate text-white text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
            {saving ? '移房中⋯' : '確認移房'}
          </button>
        </div>
      </div>
    </>
  );
}
