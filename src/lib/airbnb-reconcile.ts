import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decide, summarize, toIssues, incomingOf, forgetStaleChange,
  type Snapshot, type Existing, type PropRef, type Issue,
} from './airbnb-sync';

/**
 * 階段二：對帳。
 *
 * ============================================================
 * 【輸入是整張快照表，不是爬蟲剛送來的那幾筆】
 *
 * 這是跟改版前最大的差別。直接拿 payload 去對的話，對帳範圍
 * 被爬取範圍綁死：今天只爬了最近三個月，就只有三個月被對到。
 * 而改了一條規則想重算歷史時，唯一的辦法是把整個 Airbnb 再爬一次。
 *
 * 讀快照就沒有這個問題 —— 對帳是純資料庫的事，一次 API 都不用打，
 * 想跑幾次跑幾次。
 *
 *
 * ============================================================
 * 【為什麼獨立成一支，不寫在匯入端點裡】
 *
 * 因為它要能單獨被呼叫：
 *   · 改了規則 → 重跑對帳，不用重爬
 *   · 爬蟲掛了 → 昨天的快照還在，照樣對得出建議
 *   · 想先看看 → dryRun 跑一次，一個字都不寫
 *
 * 寫在匯入端點裡的話，這三件事都得先爬一次才做得到。
 */

/** 一次對帳的結果 */
export type ReconcileResult = {
  dryRun: boolean;
  /** 對了幾筆快照 */
  scanned: number;
  inserted: number;
  updated: number;
  voided: number;
  skipped: number;
  /** 這次才改的（快照上 changed_at 比 since 新） */
  freshChanges: number;
  unmatched: Record<string, number>;
  attention: { code: string; reason: string }[];
  issues: Issue[];
  /** 在 Airbnb 上不見了，但 ERP 還有的 */
  missing: { code: string; amount: number | null; guest: string | null }[];
};

/**
 * @param since 「這次才改的」以哪個時間為界。通常是上一輪對帳的時間 ——
 *              比它新的變動就是還沒被看過的。
 * @param range 只對某段入住日。不給就是全部 —— 全量對帳是純 DB 讀取，
 *              不打 API，所以預設就做全部
 */
export async function runReconcile(
  supabase: SupabaseClient,
  opts: {
    dryRun?: boolean;
    since?: string;
    range?: { from?: string | null; to?: string | null };
  } = {},
): Promise<ReconcileResult> {
  const dryRun = opts.dryRun === true;
  const since = opts.since ?? new Date(Date.now() - 36 * 3600_000).toISOString();

  /*
   * listing_id → 房源。**排除停用的房源** ——
   * 對照表指著「舊-A15」這種已停用的列，是訂單一直掛錯房源的根本原因。
   * 兩間房搶同一個 listing 時取啟用中的那間（排序讓 active 排後面，後寫入的贏）。
   */
  const { data: props } = await supabase
    .from('properties').select('id, name, estate_id, airbnb_listing_id, active')
    .order('active', { ascending: true });
  const byListing: Record<string, PropRef> = {};
  const staleOnly: Record<string, string> = {};
  for (const p of props ?? []) {
    if (!p.airbnb_listing_id) continue;
    const key = String(p.airbnb_listing_id);
    if (p.active) byListing[key] = { id: p.id, name: p.name, estate_id: p.estate_id };
    else if (!staleOnly[key]) staleOnly[key] = p.name;
  }

  // ── 讀快照 ──────────────────────────────────────
  const snaps: Snapshot[] = [];
  {
    /*
     * 一次 1000 列往下翻。
     *
     * Supabase 預設最多回 1000 列而且**不報錯** —— 直接 select 全部的話，
     * 第 1001 筆之後的訂單會安靜地不進對帳，而清單看起來完全正常。
     */
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      let q = supabase.from('airbnb_snapshots')
        .select('code, listing_id, guest, start_date, end_date, nights, status_key, earnings, cohost, revenue, changed_at, change_note, missing_since, last_seen, seen_count')
        .order('code')
        .range(from, from + PAGE - 1);
      if (opts.range?.from) q = q.gte('start_date', opts.range.from);
      if (opts.range?.to) q = q.lte('start_date', opts.range.to);
      const { data } = await q;
      const rows = (data ?? []) as Snapshot[];
      snaps.push(...rows);
      if (rows.length < PAGE) break;
    }
  }

  if (!snaps.length) {
    return {
      dryRun, scanned: 0, inserted: 0, updated: 0, voided: 0, skipped: 0,
      freshChanges: 0, unmatched: {}, attention: [], issues: [], missing: [],
    };
  }

  // ── 讀既有訂單 ──────────────────────────────────
  const codes = snaps.map((s) => s.code);
  const existRows: (Existing & { id: string })[] = [];
  for (let i = 0; i < codes.length; i += 400) {
    const { data } = await supabase.from('orders')
      .select('id, order_key, source, property_id, property_raw, guest_name, checkin, checkout, nights, amount, paid')
      .in('order_key', codes.slice(i, i + 400));
    existRows.push(...((data ?? []) as (Existing & { id: string })[]));
  }

  /*
   * 哪些訂單被人工改過。
   *
   * 查 data_audit 而不是在 orders 加一個欄位 —— 那張表已經是這件事的
   * 真相，另開欄位等於同一件事有兩個來源，遲早不一致。
   * 而且查 data_audit 是回溯的：2026-08 之前的人工修改一樣算數。
   *
   * user_id is not null 就代表是人 —— 服務金鑰與排程寫入時 auth.uid() 是 null。
   */
  const editedIds = new Set<string>();
  const allIds = existRows.map((e) => e.id);
  for (let i = 0; i < allIds.length; i += 400) {
    const { data } = await supabase.from('data_audit')
      .select('record_id')
      .eq('table_name', 'orders').eq('action', 'update')
      .not('user_id', 'is', null)
      .in('record_id', allIds.slice(i, i + 400));
    for (const r of data ?? []) if (r.record_id) editedIds.add(String(r.record_id));
  }
  const byCode = new Map(existRows.map((e) =>
    [e.order_key, { ...e, manually_edited: editedIds.has(e.id) }]));

  /** 今天（台北）。伺服器是 UTC，差八小時就會把退房日算錯一天 */
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' })
    .format(new Date());

  // ── 決策 ────────────────────────────────────────
  let freshChanges = 0;
  const results = snaps.map((s) => {
    // 太舊的變動記號要忘掉，否則「這次才改的」會永遠亮著
    const fresh = forgetStaleChange(s, since);
    if (fresh.change_note) freshChanges++;
    const m = incomingOf(s);
    return decide(m, byCode.get(s.code) ?? null,
      s.listing_id ? byListing[String(s.listing_id)] ?? null : null,
      { prev: fresh, today });
  });
  const sum = summarize(results);

  // ── 寫回去 ──────────────────────────────────────
  const toInsert = results
    .map((r) => r.decision).filter((d) => d.kind === 'insert')
    .map((d) => (d as Extract<typeof d, { kind: 'insert' }>).row);

  let inserted = 0, updated = 0, voided = 0;
  if (dryRun) {
    inserted = toInsert.length;
    for (const { decision } of results) {
      if (decision.kind === 'update') updated++;
      else if (decision.kind === 'void') voided++;
    }
  } else {
    for (let i = 0; i < toInsert.length; i += 200) {
      const chunk = toInsert.slice(i, i + 200);
      const { error } = await supabase.from('orders').insert(chunk);
      if (error) throw new Error(`新增訂單失敗（已寫入 ${inserted} 筆）：${error.message}`);
      inserted += chunk.length;
    }
    for (const { decision } of results) {
      if (decision.kind === 'update') {
        const { error } = await supabase.from('orders')
          .update(decision.patch).eq('order_key', decision.code);
        if (!error) updated++;
      } else if (decision.kind === 'void') {
        const { error } = await supabase.from('orders')
          .update({ source: 'airbnb_cancelled', amount: 0, fee_type: null, note: 'Airbnb 已取消,無收入' })
          .eq('order_key', decision.code);
        if (!error) voided++;
      }
    }
  }

  /*
   * 在 Airbnb 上不見了，但 ERP 還有訂單的。
   *
   * 這是全量快照才有的能力 —— 「不存在的東西」不會出現在爬蟲的結果裡，
   * 只有拿一份完整名單去減，才知道少了誰。
   *
   * 標記是階段一做的（那裡才知道掃描範圍），這裡只負責把它變成待辦。
   */
  const missing = snaps
    .filter((s) => s.missing_since && byCode.has(s.code))
    .map((s) => {
      const o = byCode.get(s.code)!;
      return { code: s.code, amount: o.amount, guest: o.guest_name };
    });

  const issues = toIssues(sum, staleOnly);
  for (const mi of missing) {
    issues.push({
      code: mi.code, field: '在 Airbnb 找不到',
      to: `${mi.guest ?? '(無名)'}　$${Math.round(Number(mi.amount) || 0).toLocaleString('en-US')}`,
      severity: 'high',
      reason: '這筆訂單在系統裡有，但爬蟲在掃描範圍內沒有再看到它。'
        + '可能是被退款結案、被 Airbnb 移除，或訂單編號改了 ——'
        + '要人去確認這筆錢到底算不算數',
    });
  }

  return {
    dryRun, scanned: snaps.length,
    inserted, updated, voided, skipped: sum.skipped,
    freshChanges,
    unmatched: sum.unmatched,
    attention: sum.attention,
    issues,
    missing,
  };
}
