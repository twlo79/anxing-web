/**
 * 移房的**讀寫**（2026-10-12 從 shortterm/page.tsx 抽出來）—— 訂單頁與房源狀態頁共用。
 * 算法在 `order-move.ts`（有測試）；這一支只負責跟資料庫講話。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { busyOfOrder, busyOfContract, type Busy } from './room-free.ts';
import { moveStateOf, moveSegments, moveError, movePatch, moveRpcSegs, type MoveState } from './order-move.ts';

/**
 * 載入一組移房（整組分段）；`id` 可以是任何一段。
 * 回傳的 `busy` 已經算好（同一組自己不算佔用、已取消不算、停用契約不算）。
 */
export async function loadMove(supabase: SupabaseClient, id: string, moveGroup?: string | null): Promise<MoveState | null> {
  let grp = moveGroup ?? null;
  if (moveGroup === undefined) {
    const { data: o } = await supabase.from('orders').select('id, move_group').eq('id', id).maybeSingle();
    if (!o) return null;
    grp = (o as any).move_group ?? null;
  }
  const g = grp || id;
  const { data: segs } = await supabase.from('orders').select('*').or(`id.eq.${g},move_group.eq.${g}`).order('checkin');
  const list = (segs ?? []) as any[];
  if (!list.length || list.some((x) => !x.checkin || !x.checkout)) return null;
  const m = moveStateOf(list, g);
  m.busy = await loadBusy(supabase, m, new Set(list.map((x) => x.id as string)));
  return m;
}

/** 找空房（2026-10-06 David：「要整段都空著的才能移」）：跟這張單期間有交集的訂單與契約 */
export async function loadBusy(supabase: SupabaseClient, m: MoveState, ids: Set<string>): Promise<Busy[]> {
  const [{ data: os }, { data: cs }] = await Promise.all([
    supabase.from('orders').select('id, move_group, property_id, estate_id, property_raw, checkin, checkout')
      .not('source', 'in', '(oneoff,airbnb_cancelled)').is('cancelled_on', null)
      .lt('checkin', m.checkout).gt('checkout', m.checkin),
    /* ★ contracts 沒有 property_id 欄（2026-10-13 查到）—— 帶了整支查詢會失敗、契約全被當成空房。用物業＋房號比 */
      supabase.from('contracts').select('estate_id, room, start_date, end_date, active')
      .lte('start_date', m.checkout).gte('end_date', m.checkin),
  ]);
  const busy: Busy[] = [];
  for (const x of (os ?? []) as any[]) {
    if (ids.has(x.id) || x.move_group === m.grp) continue;
    const b = busyOfOrder(x); if (b) busy.push(b);
  }
  for (const c of (cs ?? []) as any[]) {
    if (c.active === false) continue;
    const b = busyOfContract(c); if (b) busy.push(b);
  }
  return busy;
}

/**
 * 送出移房。`ask` 是「要不要繼續」的確認（會刪到收款紀錄時才問）；回 false ＝ 使用者取消。
 *
 * 【移房會動到收款紀錄】主段（id = grp）是 update，其他分段 delete 再重建 ——
 *   order_payments 是 on delete cascade，被重建的分段身上的收款會一起消失。不擋，只問一聲。
 *
 * ★★★ 寫入一律走 `move_order` RPC（migration_295）：任一步失敗整批退回。
 */
export async function commitMove(
  supabase: SupabaseClient, move: MoveState, ask: (text: string) => boolean,
): Promise<{ ok: boolean; message: string; cancelled?: boolean }> {
  const err = moveError(move);
  if (err) return { ok: false, message: err };
  const segs = moveSegments(move);
  const grp = move.grp;

  const { data: segIds } = await supabase.from('orders').select('id').eq('move_group', grp).neq('id', grp);
  const doomed = (segIds ?? []).map((x: any) => x.id);
  if (doomed.length) {
    const { data: lost } = await supabase.from('order_payments').select('amount').in('order_id', doomed);
    const n = (lost ?? []).length;
    if (n) {
      const amt = (lost ?? []).reduce((a: number, p: any) => a + (Number(p.amount) || 0), 0);
      if (!ask(
        `這次移房會重建分段，其中 ${n} 筆收款紀錄（$${amt.toLocaleString()}）會一併刪除。\n\n`
        + `主段的收款會保留，但金額改變後收款狀態會重新計算。\n\n`
        + `確定要繼續嗎？`,
      )) return { ok: false, message: '', cancelled: true };
    }
  }

  const { data, error } = await supabase.rpc('move_order', {
    p_grp: grp, p_segs: moveRpcSegs(segs), p_patch: movePatch(move, segs),
  });
  if (error) return { ok: false, message: '移房失敗:' + error.message };
  const r = data as { ok: boolean; message: string } | null;
  if (!r?.ok) return { ok: false, message: r?.message ?? '移房失敗' };
  return { ok: true, message: r.message };
}
