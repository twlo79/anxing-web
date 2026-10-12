'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useOnce } from '@/lib/once';
import { nightsLabel, dayBefore, type RoomRef } from '@/lib/room-free';
import {
  moveSegments, moveError, moveChain, wholeMove, splitMove, canQuickMove, splitDays, moveCandidates,
  type MoveState,
} from '@/lib/order-move';
import { loadMove, commitMove } from '@/lib/order-move-io';

/*
 * ══════════════════════════════════════════════════════════
 * 房源狀態頁的「找房移房」（2026-10-12 David 過審）
 *
 *   「找房源與移房功能在本頁做，同步狀態到訂單」
 *
 *   桌機　右側抽屜　　手機　底部抽屜（85%）
 *   兩個分頁：整段換一間 ／ 從某天起換
 *
 * ★★★ 算法與寫入**跟訂單頁同一份**（lib/order-move.ts、order-move-io.ts）——
 *   金額照晚數拆、移房鏈、備註追加、收款紀錄會刪時先問、整批走 move_order RPC。
 *   這裡只是另一個入口，不是第二套移房。
 *
 * ★ 已經分成兩段以上的單只給連到訂單頁 —— 本頁一次只看一段，
 *   在這裡改會看不到另外幾段被怎麼動。
 * ══════════════════════════════════════════════════════════
 */

export type MoveRoom = RoomRef & { estate: string };

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export default function MovePanel({ srcId, sheet, rooms, onClose, onDone }: {
  srcId: string; sheet: boolean; rooms: readonly MoveRoom[];
  onClose: () => void; onDone: (message: string) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [m, setM] = useState<MoveState | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [tab, setTab] = useState<'whole' | 'split'>('whole');
  const [day, setDay] = useState('');
  const [pickId, setPickId] = useState('');
  const [err, setErr] = useState('');
  const y0 = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    loadMove(supabase, srcId).then((x) => {
      if (!alive) return;
      if (!x) setLoadErr('讀不到這筆訂單（可能是訂金階段還沒定日期）');
      else { setM(x); setDay(splitDays(x)[0] ?? ''); }
    });
    return () => { alive = false; };
  }, [supabase, srcId]);

  const self = m?.stays[0];
  const selfRoom = self ? rooms.find((r) => r.id === self.propertyId)
    ?? rooms.find((r) => r.name === self.room && (!self.estateId || r.estate_id === self.estateId)) : undefined;
  const from = tab === 'whole' ? m?.checkin ?? '' : day;
  const cands = useMemo(() => (m?.busy
    ? moveCandidates(m.busy, rooms, from, m.checkout, selfRoom?.id ?? null, self?.estateId ?? null)
    : { free: [], partly: [] }), [m, rooms, from, selfRoom, self]);

  const target = rooms.find((r) => r.id === pickId);
  /* 選了房之後才組出要送的狀態；換分頁或換日子時，已選的房不在新清單裡就取消選取 */
  const next = m && target ? (tab === 'whole' ? wholeMove(m, target) : splitMove(m, day, target)) : null;
  useEffect(() => { if (pickId && !cands.free.some((r) => r.id === pickId)) setPickId(''); }, [cands, pickId]);
  const segs = next ? moveSegments(next) : [];
  const blocked = next ? moveError(next) : null;

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
    : 'fixed top-0 right-0 h-full w-[400px] max-w-full border-l border-mor-line';

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="找房移房"
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
            <span className="text-base font-bold">找房移房</span>
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
                  {md(m.checkin)} ～ {md(dayBefore(m.checkout))}（最後一晚）・{m.totalNights} 晚
                </div>
              </div>

              {!canQuickMove(m) ? (
                <div className="mt-3 text-sm text-gray-600 leading-relaxed">
                  這筆已經分成 {m.stays.length} 段，在這裡只看得到其中一段 ——
                  到訂單頁一起調整：
                  <a href={`/shortterm?move=${m.grp}`} target="_blank" rel="noreferrer"
                    className="ml-1 font-medium text-mor-slate hover:text-mor-slatedark">打開訂單頁的移房 →</a>
                </div>
              ) : (
                <>
                  <div className="mt-3 flex rounded-lg bg-mor-sand p-1">
                    {([['whole', '整段換一間'], ['split', '從某天起換']] as const).map(([k, t]) => (
                      <button key={k} onClick={() => setTab(k)} disabled={k === 'split' && !splitDays(m).length}
                        title={k === 'split' && !splitDays(m).length ? '只住一晚，沒有「中途」可以換' : undefined}
                        className={`flex-1 rounded-md py-2 text-sm disabled:opacity-40 ${
                          tab === k ? 'bg-white font-semibold shadow-sm' : 'text-gray-600'}`}>{t}</button>
                    ))}
                  </div>

                  {tab === 'split' && (
                    <label className="mt-3 flex items-center gap-2 text-sm">
                      <span className="text-gray-500 whitespace-nowrap">哪一天起換</span>
                      <select value={day} onChange={(e) => setDay(e.target.value)}
                        className="flex-1 h-10 rounded-lg border border-gray-300 px-2 text-ui">
                        {splitDays(m).map((d) => <option key={d} value={d}>{md(d)} 起（前 {Math.round((new Date(d).getTime() - new Date(m.checkin).getTime()) / 86400000)} 晚留在 {m.stays[0].room}）</option>)}
                      </select>
                    </label>
                  )}

                  <div className="mt-3 mb-1.5 text-[11px] text-gray-400">
                    只列 {from ? nightsLabel(from, m.checkout) : '—'} 每一晚都空的房源
                  </div>
                  {!m.busy && <div className="py-4 text-center text-xs text-gray-400">查空房中⋯</div>}
                  {m.busy && cands.free.length === 0 && (
                    <div className="rounded-lg bg-mor-bg px-3 py-3 text-center text-xs text-gray-500">這段期間沒有整段都空的房源</div>
                  )}
                  <div className="space-y-1.5">
                    {cands.free.map((r) => (
                      <button key={r.id} onClick={() => setPickId(r.id)}
                        className={`w-full flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left ${
                          pickId === r.id ? 'border-mor-slate bg-mor-bluelight' : 'border-mor-line bg-white hover:bg-mor-bg'}`}>
                        <b className="min-w-[3.5rem] text-sm">{r.name}</b>
                        <span className="flex-1 text-xs text-gray-500">{r.estate}</span>
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
                              {busyNights} 晚有人{tab === 'whole' ? ' —— 改用「從某天起換」' : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {next && (
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
                        {segs.length > 1 ? '金額照晚數拆，押金留在第 1 段。' : '只換房號，金額不變。'}
                        備註會加一行「移房 {moveChain(m.origRooms, segs.map((x) => x.room)).join('>')}」，原本的備註留著。
                      </div>
                    </div>
                  )}
                </>
              )}
              {(err || blocked) && <div className="mt-2 text-xs text-red-600">{err || blocked}</div>}
            </>
          )}
        </div>
        <div className="shrink-0 flex gap-2 border-t border-mor-line px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button onClick={onClose} className="flex-1 h-12 rounded-xl border border-mor-line text-sm">取消</button>
          <button onClick={save} disabled={!next || !!blocked || saving}
            title={!next ? '先選一間房' : blocked ?? undefined}
            className="flex-1 h-12 rounded-xl bg-mor-slate text-white text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
            {saving ? '移房中⋯' : '確認移房'}
          </button>
        </div>
      </div>
    </>
  );
}
