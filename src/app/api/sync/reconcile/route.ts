import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { runReconcile } from '@/lib/airbnb-reconcile';

/**
 * 階段二：拿整張快照表跟 ERP 對帳。**不爬任何東西。**
 *
 * ============================================================
 * 【什麼時候會單獨呼叫這支】
 *
 *   · 改了規則想重算歷史 —— 以前要把整個 Airbnb 再爬一次（幾千次
 *     請求、會被限流），現在只是一次資料庫掃描
 *   · 爬蟲掛了 —— 昨天的快照還在，照樣對得出建議
 *   · 回填完 —— 分批寫完快照之後，最後跑一次涵蓋全部
 *   · 想先看看 —— dryRun 算出「會做什麼」，一個字都不寫
 *
 * 這正是把爬取與對帳拆開換來的東西：對帳不再需要網路。
 *
 *
 * 【參數】（全部選填）
 *   dryRun  true            只算不寫
 *   since   ISO 時間        「這次才改的」以哪個時間為界。
 *                           預設 36 小時內 —— 涵蓋昨晚那一輪，
 *                           同時不會把三個月前改過的也算成新的
 *   from/to yyyy-mm-dd      只對某段入住日
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!process.env.IMPORT_KEY || req.headers.get('x-import-key') !== process.env.IMPORT_KEY)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'no service key' }, { status: 500 });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dryRun === true;

  let rec;
  try {
    rec = await runReconcile(supabase, {
      dryRun,
      since: body.since,
      range: { from: body.from ?? null, to: body.to ?? null },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  /*
   * 試算不寫流水帳，也不動建議清單 ——
   * 否則「先看看」會把正式那一份蓋掉。
   */
  if (!dryRun) {
    const { error } = await supabase.rpc('record_sync_run', {
      p_kind: 'orders',
      p_counts: {
        received: rec.scanned,
        inserted: rec.inserted, updated: rec.updated,
        voided: rec.voided, skipped: rec.skipped,
        detail: {
          來源: '手動對帳（沒有爬取）',
          對帳筆數: rec.scanned,
          這次才改的: rec.freshChanges,
          在Airbnb找不到: rec.missing.length,
          待人工判斷: rec.attention.length,
          對不到房源: Object.keys(rec.unmatched).length,
        },
      },
      p_issues: rec.issues,
    });
    if (error) console.error('[reconcile] 同步紀錄寫入失敗（對帳本身不受影響）:', error.message);
  }

  return NextResponse.json({
    dryRun,
    對了幾筆: rec.scanned,
    inserted: rec.inserted, updated: rec.updated, voided: rec.voided, skipped: rec.skipped,
    這次才改的: rec.freshChanges,
    在Airbnb找不到: rec.missing,
    待人工判斷: rec.attention,
    對不到房源: rec.unmatched,
    建議: rec.issues.length,
  });
}
