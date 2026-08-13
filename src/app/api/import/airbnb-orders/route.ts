import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { notifyImport } from '@/lib/push';
import { decide, summarize, toIssues, type Incoming, type Existing, type PropRef } from '@/lib/airbnb-sync';
import { orderLine, importBody, importTitle } from '@/lib/notify-text';

/**
 * Airbnb 訂單匯入。
 *
 * 決策邏輯全部在 `@/lib/airbnb-sync`（純函式、有測試）——
 * 這裡只負責讀資料庫、照決策寫回去、回報結果。
 *
 * 【2026-08 改版：爬蟲不再蓋掉人工修正】
 * 之前每次同步都覆寫房源與姓名，所以手動改過的房源隔天就被改回去，
 * 而且完全無聲。現在房源與姓名「只在空的時候填」，不一致改成回報。
 * 詳細的分級與理由寫在 lib/airbnb-sync.ts 的檔頭。
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
  const items: Incoming[] = body.reservations ?? [];
  /*
   * 試算模式：算出「會做什麼」，但一個字都不寫。
   *
   * 【為什麼需要】
   * 補對帳要掃全部歷史訂單，而那批裡面有很多是當初刻意沒匯入的
   * （很久以前的取消單之類）。正常模式會把它們通通新增進來 ——
   * 為了查金額而多出幾百筆訂單，那個代價比原本的問題還大。
   *
   * 試算模式讓「先看看」跟「真的做」變成兩件事。
   */
  const dryRun = body.dryRun === true;
  if (!items.length) return NextResponse.json({ upserted: 0 }, { headers: CORS });

  /*
   * listing_id → 房源。
   *
   * **排除停用的房源**：對照表指著「舊-A15」這種已停用的列，
   * 是訂單一直掛錯房源的根本原因。停用代表那間房不再營運，
   * 新訂單不該掛上去。
   *
   * 兩間房搶同一個 listing 時取「啟用中的那間」——
   * 排序讓 active 的排後面，後寫入的會贏。
   */
  const { data: props } = await supabase
    .from('properties').select('id, name, estate_id, airbnb_listing_id, active')
    .order('active', { ascending: true });
  const byListing: Record<string, PropRef> = {};
  const staleOnly: Record<string, string> = {};   // listing → 只對到停用房源
  for (const p of props ?? []) {
    if (!p.airbnb_listing_id) continue;
    const key = String(p.airbnb_listing_id);
    if (p.active) byListing[key] = { id: p.id, name: p.name, estate_id: p.estate_id };
    else if (!staleOnly[key]) staleOnly[key] = p.name;
  }

  // 既有訂單：一次抓齊決策需要的欄位
  const codes = items.map((m) => String(m.code)).filter(Boolean);
  const existRows: (Existing & { id: string })[] = [];
  for (let i = 0; i < codes.length; i += 400) {
    const { data } = await supabase.from('orders')
      .select('id, order_key, source, property_id, property_raw, guest_name, checkin, checkout, amount, paid')
      .in('order_key', codes.slice(i, i + 400));
    existRows.push(...((data ?? []) as (Existing & { id: string })[]));
  }

  /*
   * 哪些訂單被人工改過。
   *
   * 【為什麼查 data_audit，而不是在 orders 加一個欄位】
   * 那張表已經是這件事的真相 —— 「誰在什麼時候改了什麼」本來就記在那裡。
   * 另開一個欄位等於同一件事有兩個來源，而兩個來源遲早會不一致
   * （補資料、批次修正、直接下 SQL…都會漏掉其中一個）。
   *
   * 而且查 data_audit 是**回溯的**：2026-08 之前的人工修改一樣算數，
   * 不需要先跑一支 migration 去回填。
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

  // ── 決策 ────────────────────────────────────────
  const results = items.map((m) =>
    decide(m, byCode.get(String(m.code)) ?? null,
      m.listingId ? byListing[String(m.listingId)] ?? null : null));
  const s = summarize(results);

  // ── 寫回去 ──────────────────────────────────────
  const toInsert = results
    .map((r) => r.decision).filter((d) => d.kind === 'insert')
    .map((d) => (d as Extract<typeof d, { kind: 'insert' }>).row);

  let inserted = 0;
  if (dryRun) {
    inserted = toInsert.length;      // 「會新增幾筆」，但不寫
  } else {
    for (let i = 0; i < toInsert.length; i += 200) {
      const chunk = toInsert.slice(i, i + 200);
      const { error } = await supabase.from('orders').insert(chunk);
      if (error) return NextResponse.json({ error: error.message, inserted }, { status: 500, headers: CORS });
      inserted += chunk.length;
    }
  }

  let updated = 0, voided = 0;
  for (const { decision } of results) {
    if (dryRun) {
      if (decision.kind === 'update') updated++;
      else if (decision.kind === 'void') voided++;
      continue;
    }
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

  /*
   * 只有真的新增才發通知。
   *
   * 更新既有訂單（改日期、改金額）每天都有一堆，每筆一則的話
   * 手機會叮到沒人想看 —— 那種通知很快就會被整個關掉，
   * 連真正重要的那則也一起失效。
   *
   * 內文列出每一筆的金額／房源／房客／期間（金額在最前面）——
   * 「新增 3 筆訂單」那種通知沒有一個字能幫你決定要不要點進去。
   */
  if (inserted > 0 && !dryRun) {
    const lines = toInsert.map((r) => orderLine({
      amount: Number(r.amount) || 0,
      property: r.property_raw == null ? null : String(r.property_raw),
      guest: r.guest_name == null ? null : String(r.guest_name),
      checkin: r.checkin == null ? null : String(r.checkin),
      checkout: r.checkout == null ? null : String(r.checkout),
    }));
    await notifyImport('orders', importTitle(inserted, '筆', '訂單'),
      importBody(lines), '/shortterm');
  }

  /*
   * 房源不一致的清單就是「對照表該怎麼搬」的作業。
   * 附上 listing 目前只對到哪個停用房源 —— 那通常就是元兇。
   */
  const propDiffs = s.diffs.filter((d) => d.field === '房源').map((d) => ({
    ...d, 停用對照: d.listingId ? staleOnly[d.listingId] ?? null : null,
  }));

  /*
   * 把這一輪的結果留在資料庫，畫面上才看得到爬蟲做了什麼。
   *
   * record_sync_run 會把差異清單**整批換成這一輪的結果** ——
   * 沒再出現的自動刪掉，所以對照表修好之後那一列隔天就不見了。
   * 清單空了就代表真的沒事，這是流水帳給不了的保證。
   *
   * 寫失敗不影響匯入本身 —— 資料已經進去了，回報不該讓排程以為要重跑。
   */
  // 試算不寫流水帳,也不動待辦清單 —— 否則「先看看」會把正式那份蓋掉
  const { error: logErr } = dryRun ? { error: null } : await supabase.rpc('record_sync_run', {
    p_kind: 'orders',
    p_counts: {
      received: items.length, inserted, updated, voided, skipped: s.skipped,
      detail: {
        人工編輯過: existRows.filter((e) => editedIds.has(e.id)).length,
        金額不一致: s.diffs.filter((d) => d.field === '金額').length,
        房源不一致: propDiffs.length,
        房客姓名不同: s.diffs.filter((d) => d.field === '房客姓名').length,
        住宿起訖已更新: s.diffs.filter((d) => d.field === '住宿起訖').length,
        待人工判斷: s.attention.length,
        對不到房源: Object.keys(s.unmatched).length,
      },
    },
    p_issues: toIssues(s, staleOnly),
  });
  if (logErr) console.error('[sync] 同步紀錄寫入失敗（匯入本身不受影響）:', logErr.message);

  return NextResponse.json({
    dryRun,
    received: items.length,
    inserted, updated, voided,
    skipped: s.skipped,
    unmatched: s.unmatched,
    /** listing 只對到停用的房源 —— 這些要到 /admin 把 listing_id 搬到現行房源 */
    staleListings: Object.entries(s.unmatched)
      .filter(([lid]) => staleOnly[lid])
      .map(([lid, n]) => ({ listingId: lid, 停用房源: staleOnly[lid], 筆數: n })),
    /** 已收款卻顯示取消 —— 不自動歸零，要人工判斷 */
    needsAttention: s.attention,
    /** 爬蟲想改但被擋下來的（房源、姓名），以及已經改掉的日期 */
    /** 人工編輯過、因此完全沒被碰的訂單數 */
    人工編輯過: existRows.filter((e) => editedIds.has(e.id)).length,
    差異: {
      金額: s.diffs.filter((d) => d.field === '金額'),
      房源: propDiffs,
      房客姓名: s.diffs.filter((d) => d.field === '房客姓名'),
      住宿起訖已更新: s.diffs.filter((d) => d.field === '住宿起訖'),
    },
  }, { headers: CORS });
}
