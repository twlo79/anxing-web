import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CORS = {
  'Access-Control-Allow-Origin': 'https://www.airbnb.com',
  'Access-Control-Allow-Headers': 'content-type, x-import-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

const auth = (req: Request) => !!process.env.IMPORT_KEY && req.headers.get('x-import-key') === process.env.IMPORT_KEY;

/**
 * 撤評對帳。
 *
 * 呼叫端傳入「Airbnb 目前still存在的全部評價 id」,本端算出 DB 有、Airbnb 沒有的差集,
 * 那些就是被撤下的評價。刪除不可逆,所以三道護欄缺一不可:
 *
 *   1. 抓取完整性 —— 傳了 totalCount 就必須與 ids 筆數相符,中途斷線的殘缺清單一律拒絕
 *   2. 比例閘     —— ids 少於 DB 現有的 90% 判定為抓取失敗(session 過期 / Airbnb 改版)
 *   3. 刪除上限   —— 超過 maxDelete 筆整批拒絕。一次少幾百筆不會是真的撤評
 *
 * 預設 dryRun=true:先看會刪什麼,確認無誤再帶 dryRun=false 實際執行。
 *
 * body: { ids: string[], totalCount?: number, scope?: 'auto'|'all',
 *         dryRun?: boolean, maxDelete?: number }
 */
export async function POST(req: Request) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'no service key' }, { status: 500, headers: CORS });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);

  const body = await req.json();
  const ids: string[] = (body.ids ?? []).map((x: any) => String(x));
  const totalCount: number | null = body.totalCount == null ? null : Number(body.totalCount);
  const scope: string = body.scope === 'all' ? 'all' : 'auto';
  const dryRun: boolean = body.dryRun !== false;          // 預設 true
  const maxDelete: number = Number(body.maxDelete ?? 5);

  if (!ids.length)
    return NextResponse.json({ error: 'ids 為空,拒絕執行' }, { status: 400, headers: CORS });

  // ── 護欄 1:抓取完整性 ────────────────────────────────────────────
  const uniqueIds = Array.from(new Set(ids));
  if (totalCount != null && uniqueIds.length !== totalCount) {
    return NextResponse.json({
      error: 'aborted_incomplete_fetch',
      detail: `Airbnb 回報 ${totalCount} 筆,實際只收到 ${uniqueIds.length} 筆,判定抓取不完整`,
      received: uniqueIds.length, totalCount,
    }, { status: 409, headers: CORS });
  }

  // ── 取出 DB 內受管轄的評價 ──────────────────────────────────────
  const dbRows: any[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    let q = supabase.from('reviews')
      .select('airbnb_review_id, guest_name, checkin_date, checkout_date, overall_rating, comment, comment_original, listing_name_raw, imported_via')
      .order('airbnb_review_id', { ascending: true })
      .range(from, from + 999);
    if (scope === 'auto') q = q.eq('imported_via', 'auto');
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS });
    if (!data || !data.length) break;
    dbRows.push(...data);
    if (data.length < 1000) break;
  }

  // ── 護欄 2:比例閘 ──────────────────────────────────────────────
  if (dbRows.length > 0 && uniqueIds.length < dbRows.length * 0.9) {
    return NextResponse.json({
      error: 'aborted_ratio_guard',
      detail: `只抓到 ${uniqueIds.length} 筆,DB 現有 ${dbRows.length} 筆(不足 90%),判定抓取失敗,不執行任何刪除`,
      fetched: uniqueIds.length, dbCount: dbRows.length,
    }, { status: 409, headers: CORS });
  }

  // ── 差集:DB 有、Airbnb 沒有 = 被撤下 ────────────────────────────
  const live = new Set(uniqueIds);
  const missing = dbRows.filter((r) => !live.has(String(r.airbnb_review_id)));

  // ── 護欄 3:刪除上限 ────────────────────────────────────────────
  if (missing.length > maxDelete) {
    return NextResponse.json({
      error: 'aborted_too_many',
      detail: `有 ${missing.length} 筆在 Airbnb 消失,超過單次上限 ${maxDelete} 筆。已中止,未刪除任何資料,請人工確認`,
      wouldDelete: missing.length, maxDelete, rows: missing,
    }, { status: 409, headers: CORS });
  }

  // 對帳日期由本端記錄,不靠呼叫端。
  // 呼叫端記的話,「跑完但沒回寫」跟「根本沒跑」分不出來 ——
  // 而這兩者的差別就是明天要不要再跑一次 30 次請求的全量對帳。
  const markReconciled = async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { data: st } = await supabase.from('sync_state').select('value').eq('key', 'reviews').maybeSingle();
    await supabase.rpc('set_sync_state', {
      p_key: 'reviews',
      p_value: { ...((st?.value as any) ?? {}), lastFullReconcile: today },
    });
  };

  if (!missing.length) {
    await markReconciled();   // 沒東西要刪也是「對過了」
    return NextResponse.json({ scope, dryRun, dbCount: dbRows.length, fetched: uniqueIds.length, deleted: 0, rows: [] }, { headers: CORS });
  }

  // ── 執行 ────────────────────────────────────────────────────────
  // rows 一律完整回傳,呼叫端負責留存;硬刪除後 DB 內不會再有痕跡。
  if (dryRun)
    return NextResponse.json({ scope, dryRun: true, dbCount: dbRows.length, fetched: uniqueIds.length, wouldDelete: missing.length, rows: missing }, { headers: CORS });

  const { error } = await supabase.from('reviews').delete()
    .in('airbnb_review_id', missing.map((r) => String(r.airbnb_review_id)));
  if (error) return NextResponse.json({ error: error.message, rows: missing }, { status: 500, headers: CORS });

  await markReconciled();
  return NextResponse.json({ scope, dryRun: false, dbCount: dbRows.length, fetched: uniqueIds.length, deleted: missing.length, rows: missing }, { headers: CORS });
}
