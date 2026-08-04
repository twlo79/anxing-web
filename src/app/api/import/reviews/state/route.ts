import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': 'https://www.airbnb.com',
  'Access-Control-Allow-Headers': 'content-type, x-import-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

const auth = (req: Request) =>
  !!process.env.IMPORT_KEY && req.headers.get('x-import-key') === process.env.IMPORT_KEY;

const client = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

/**
 * 撤評哨兵的狀態來源。
 *
 * 【為什麼不放本機檔】
 * 原本狀態存在 sync-backups/sync-state.json,那個檔只存在於跑同步的那一台機器上。
 * 換機器 / 換路徑之後,哨兵的第 3 條「找不到 topReviewId → 強制全量對帳」會天天觸發,
 * 而症狀跟「一天真的新增超過 50 筆」完全一樣 —— 每天多跑 30 次請求,沒人會發現。
 *
 * 【回傳什麼】
 *   dbCount           DB 現有評價數(受管轄範圍,預設 imported_via='auto')
 *   recentIds         最近匯入的 300 筆 airbnb_review_id
 *                     呼叫端拿今天抓到的 50 筆跟它比,差集就是今天的新評價,
 *                     不需要「找 topReviewId 在第幾個」那種位置比對 ——
 *                     位置比對在有評價被刪掉時會算錯。
 *   lastFullReconcile 上次全量對帳日期(YYYY-MM-DD),沒跑過是 null
 *
 * GET  ?scope=auto|all
 */
export async function GET(req: Request) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'no service key' }, { status: 500, headers: CORS });
  const supabase = client();

  const scope = new URL(req.url).searchParams.get('scope') === 'all' ? 'all' : 'auto';

  let countQ = supabase.from('reviews').select('airbnb_review_id', { count: 'exact', head: true });
  if (scope === 'auto') countQ = countQ.eq('imported_via', 'auto');
  const { count, error: ce } = await countQ;
  if (ce) return NextResponse.json({ error: ce.message }, { status: 500, headers: CORS });

  // 用 scraped_at 排序而不是 id —— airbnb_review_id 是字串,字典序不等於時間序,
  // 位數一變(19 → 20 碼)排序就會錯,而且錯得很安靜。
  let recentQ = supabase.from('reviews')
    .select('airbnb_review_id')
    .order('scraped_at', { ascending: false })
    .limit(300);
  if (scope === 'auto') recentQ = recentQ.eq('imported_via', 'auto');
  const { data: recent, error: re } = await recentQ;
  if (re) return NextResponse.json({ error: re.message }, { status: 500, headers: CORS });

  const { data: st } = await supabase.from('sync_state').select('value').eq('key', 'reviews').maybeSingle();

  return NextResponse.json({
    scope,
    dbCount: count ?? 0,
    recentIds: (recent ?? []).map((r) => String(r.airbnb_review_id)),
    lastFullReconcile: (st?.value as any)?.lastFullReconcile ?? null,
    lastSyncAt: (st?.value as any)?.lastSyncAt ?? null,
  }, { headers: CORS });
}

/**
 * 記錄同步跑過了。
 *
 * body: { lastFullReconcile?: 'YYYY-MM-DD', lastSyncAt?: ISO string, note?: string }
 * 只覆蓋有帶的欄位,沒帶的沿用舊值 —— 每天的同步不該把上次對帳日洗掉。
 */
export async function POST(req: Request) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'no service key' }, { status: 500, headers: CORS });
  const supabase = client();

  const body = await req.json().catch(() => ({}));
  const { data: st } = await supabase.from('sync_state').select('value').eq('key', 'reviews').maybeSingle();
  const merged = { ...((st?.value as any) ?? {}) };

  for (const k of ['lastFullReconcile', 'lastSyncAt', 'note'] as const) {
    if (body[k] != null) merged[k] = body[k];
  }
  if (body.lastSyncAt == null) merged.lastSyncAt = new Date().toISOString();

  const { error } = await supabase.rpc('set_sync_state', { p_key: 'reviews', p_value: merged });
  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS });

  return NextResponse.json({ ok: true, value: merged }, { headers: CORS });
}
