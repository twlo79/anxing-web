import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { notifyImport } from '@/lib/push';
import {
  dedupe, snapshotRowOf, snapshotChanges, findMissing,
  type Incoming, type Snapshot,
} from '@/lib/airbnb-sync';
import { runReconcile } from '@/lib/airbnb-reconcile';
import { orderLine, importBody, importTitle } from '@/lib/notify-text';

/**
 * Airbnb 訂單匯入 —— **階段一：只寫快照**。
 *
 * ============================================================
 * 【這支端點不再直接改訂單】（2026-08-14 使用者決定）
 *
 * 爬蟲抓回來的東西一律先進 airbnb_snapshots，那是 Airbnb 的鏡像。
 * 之後才由 lib/airbnb-reconcile 拿整張快照表去跟 orders 對帳。
 *
 * 【為什麼要拆】
 * 直接對的話，對帳範圍被爬取範圍綁死 —— 今天只爬了最近三個月，
 * 就只有三個月被對到。而改了一條規則想重算歷史時，唯一的辦法是
 * 把整個 Airbnb 再爬一次：幾千次請求，而且會被限流。
 *
 * 拆開之後對帳是純資料庫的事，想跑幾次跑幾次。
 *
 * 【爬蟲不用改】
 * 送進來的格式完全沒變。多了兩個**選填**參數：
 *   scope    { from, to }  這一輪掃了哪段入住日 —— 有給才做消失偵測
 *   skipReconcile  true    只寫快照，不對帳（回填時用）
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CORS = {
  'Access-Control-Allow-Origin': 'https://www.airbnb.com',
  'Access-Control-Allow-Headers': 'content-type, x-import-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function POST(req: Request) {
  if (!process.env.IMPORT_KEY || req.headers.get('x-import-key') !== process.env.IMPORT_KEY)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'no service key' }, { status: 500, headers: CORS });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);

  const body = await req.json();
  const raw: Incoming[] = body.reservations ?? [];
  const dryRun = body.dryRun === true;
  /**
   * 回填模式：只把歷史寫進快照，不對帳。
   *
   * 全量回填要分好幾批跑，每一批都對帳一次是白費工 ——
   * 對帳讀的是整張表，最後跑一次就涵蓋全部。
   */
  const skipReconcile = body.skipReconcile === true;
  /** 這一輪掃了哪段入住日。爬蟲沒給就不做消失偵測 */
  const scope: { from?: string | null; to?: string | null } | null = body.scope ?? null;

  /*
   * 第一件事就去重。
   *
   * 爬蟲翻頁時同一筆訂單出現在兩頁是常態（Airbnb 的分頁依時間切，
   * 邊界那幾筆會重複）。不去重的話同一個確認碼會走兩次決策，
   * 兩次都判斷「這是新訂單」，然後插入兩列 —— 而重複的訂單
   * 在報表上看起來完全正常，只是那個月多了一筆錢。
   */
  const { items, dropped: duplicates } = dedupe(raw);
  if (!items.length) return NextResponse.json({ upserted: 0, duplicates }, { headers: CORS });

  const runStart = new Date().toISOString();
  const codes = items.map((m) => String(m.code));

  // ── 這些 code 上次長什麼樣 ──────────────────────
  const prevRows: Snapshot[] = [];
  for (let i = 0; i < codes.length; i += 400) {
    const { data } = await supabase.from('airbnb_snapshots')
      .select('code, listing_id, guest, start_date, end_date, nights, status_key, earnings, cohost, revenue, changed_at, change_note, seen_count')
      .in('code', codes.slice(i, i + 400));
    prevRows.push(...((data ?? []) as Snapshot[]));
  }
  const prevByCode = new Map(prevRows.map((s) => [s.code, s]));

  /** Airbnb 那邊真的改了的 —— 純比對答不出來的那句話 */
  const changed = items
    .map((m) => ({ code: String(m.code), changes: snapshotChanges(prevByCode.get(String(m.code)), m) }))
    .filter((x) => x.changes.length > 0);

  // ── 寫快照 ──────────────────────────────────────
  const rows = items.map((m) => snapshotRowOf(m, prevByCode.get(String(m.code)), runStart));
  let saved = 0;
  if (!dryRun) {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await supabase.from('airbnb_snapshots')
        .upsert(chunk, { onConflict: 'code' });
      if (error) {
        return NextResponse.json({ error: error.message, saved }, { status: 500, headers: CORS });
      }
      saved += chunk.length;
    }
  } else {
    saved = rows.length;
  }

  /*
   * 掃描範圍內卻沒出現的 = 在 Airbnb 上不見了。
   *
   * 【為什麼一定要有範圍】
   * 爬蟲每天只抓最近幾頁，一年前的訂單本來就不會出現。
   * 拿「這輪沒看到」當「不見了」，會把幾千筆正常歷史全標成失蹤 ——
   * 而那樣的清單沒有人會看第二次，連真的不見的那一筆也被埋掉。
   *
   * 沒給範圍就完全不做。不知道掃了哪裡就說某筆不見了，那不是偵測，是猜。
   */
  let missing: string[] = [];
  if (scope?.from && scope?.to && !dryRun) {
    const inScope: Snapshot[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data } = await supabase.from('airbnb_snapshots')
        .select('code, start_date, last_seen, missing_since')
        .gte('start_date', scope.from).lte('start_date', scope.to)
        .order('code').range(from, from + PAGE - 1);
      const got = (data ?? []) as Snapshot[];
      inScope.push(...got);
      if (got.length < PAGE) break;
    }
    missing = findMissing(inScope, scope, runStart).map((s) => s.code);
    for (let i = 0; i < missing.length; i += 200) {
      await supabase.from('airbnb_snapshots')
        .update({ missing_since: runStart })
        .in('code', missing.slice(i, i + 200));
    }
  }

  // ── 階段二：對帳 ────────────────────────────────
  const rec = skipReconcile || dryRun
    ? null
    : await runReconcile(supabase, { since: runStart, dryRun: false });

  /*
   * 只有真的新增訂單才發通知。
   *
   * 更新既有訂單每天都有一堆，每筆一則的話手機會叮到沒人想看 ——
   * 那種通知很快就會被整個關掉，連真正重要的那則也一起失效。
   *
   * 內文列出每一筆的金額／房源／房客／期間（金額在最前面）——
   * 「新增 3 筆訂單」那種通知沒有一個字能幫你決定要不要點進去。
   */
  if (rec && rec.inserted > 0) {
    const { data: fresh } = await supabase.from('orders')
      .select('amount, property_raw, guest_name, checkin, checkout')
      .eq('imported_via', 'auto')
      .order('created_at', { ascending: false })
      .limit(rec.inserted);
    const lines = (fresh ?? []).map((r) => orderLine({
      amount: Number(r.amount) || 0,
      property: r.property_raw == null ? null : String(r.property_raw),
      guest: r.guest_name == null ? null : String(r.guest_name),
      checkin: r.checkin == null ? null : String(r.checkin),
      checkout: r.checkout == null ? null : String(r.checkout),
    }));
    await notifyImport('orders', importTitle(rec.inserted, '筆', '訂單'),
      importBody(lines), '/shortterm');
  }

  /*
   * 把這一輪的結果留在資料庫，畫面上才看得到爬蟲做了什麼。
   *
   * record_sync_run 會把建議清單**整批換成這一輪的結果** ——
   * 沒再出現的自動刪掉，所以對照表修好之後那一列隔天就不見了。
   * 清單空了就代表真的沒事，這是流水帳給不了的保證。
   *
   * 寫失敗不影響匯入本身 —— 資料已經進去了，回報不該讓排程以為要重跑。
   */
  if (!dryRun && rec) {
    const { error: logErr } = await supabase.rpc('record_sync_run', {
      p_kind: 'orders',
      p_counts: {
        received: raw.length,
        inserted: rec.inserted, updated: rec.updated,
        voided: rec.voided, skipped: rec.skipped,
        scanFrom: scope?.from ?? null,
        scanTo: scope?.to ?? null,
        detail: {
          // 長期應該是 0 —— 一直有值代表爬蟲的分頁邏輯有問題，
          // 而不是「反正有去重就沒事」
          重複已濾掉: duplicates,
          寫入快照: saved,
          Airbnb這次改了: changed.length,
          對帳筆數: rec.scanned,
          在Airbnb找不到: rec.missing.length,
          待人工判斷: rec.attention.length,
          對不到房源: Object.keys(rec.unmatched).length,
        },
      },
      p_issues: rec.issues,
    });
    if (logErr) console.error('[sync] 同步紀錄寫入失敗（匯入本身不受影響）:', logErr.message);
  }

  return NextResponse.json({
    dryRun,
    /** ── 階段一：爬取 ── */
    received: raw.length,
    duplicates,
    快照已寫入: saved,
    Airbnb這次改了: changed,
    在Airbnb找不到: missing,
    /** ── 階段二：對帳（skipReconcile 時是 null）── */
    對帳: rec && {
      對了幾筆: rec.scanned,
      inserted: rec.inserted, updated: rec.updated, voided: rec.voided,
      skipped: rec.skipped,
      這次才改的: rec.freshChanges,
      待人工判斷: rec.attention,
      對不到房源: rec.unmatched,
      建議: rec.issues.length,
    },
  }, { headers: CORS });
}
