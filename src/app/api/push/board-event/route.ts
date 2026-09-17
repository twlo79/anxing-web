import { NextResponse } from 'next/server';
import { adminClient, filterByPref, initWebPush, pushConfigured, sendToUsers } from '@/lib/push';
import { kindLabel, fmtEventWhen } from '@/lib/board';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';   // web-push 需要 Node 環境,不能跑在 edge

/**
 * 由 Supabase Database Webhook 呼叫，佈告欄排了新活動時推播。
 *
 * ══════════════════════════════════════════════════════════
 * 【怎麼接上】（推上去之後**要自己去 Supabase 後台設**）
 *
 *   Database → Webhooks → Create a new hook
 *     Table      public.board_events
 *     Events     Insert
 *     Type       HTTP Request → POST
 *     URL        https://<你的網址>/api/push/board-event
 *     Headers    x-push-key: <跟 PUSH_KEY 環境變數一樣的值>
 *
 * ★★★ 沒設的話，畫面一切正常、活動也建得起來，**就是不會有通知** ——
 *   而那件事不會有任何錯誤訊息。請款單那支（/api/push/notify）也是這樣接的。
 *
 * ══════════════════════════════════════════════════════════
 * 【收件人：全公司在職的人，排除排這場的人自己】
 *
 * ★ 排除本人是降噪:他剛按下建立,不需要系統再叮他一次
 *   （跟請款單那支同一個規則）。
 *
 * ★★ 然後再過一次「這個人的活動通知有沒有開」（notification_prefs.board）。
 *   沒有偏好列的人退回預設 —— 那份預設寫在 lib/notify-kinds.ts，
 *   跟 migration_265 的 column default 對齊。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 只推「新增」，不推每一次修改】
 *
 * webhook 只掛 Insert。掛上 Update 的話，改一個錯字、打開上傳開關
 * 都會叮全公司一次 —— 而被叮了三次沒意義的通知之後，
 * 人就不會再點這種通知了，**包括真的要看的那一則**。
 */
export async function POST(req: Request) {
  const key = process.env.PUSH_KEY;
  if (!key) return NextResponse.json({ error: 'no push key' }, { status: 500 });
  if (req.headers.get('x-push-key') !== key)
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  if (!pushConfigured())
    return NextResponse.json({ error: 'push not configured' }, { status: 500 });

  initWebPush();
  const admin = adminClient();

  // Supabase webhook 的格式是 { type, table, record, old_record }
  const body = await req.json().catch(() => ({}));
  const rec = body.record ?? body;
  if (!rec?.id || !rec?.starts_at)
    return NextResponse.json({ error: 'no record' }, { status: 400 });

  /*
   * ★ 只處理新增。webhook 設錯成 Update 也不會炸，只是安靜跳過 ——
   *   比每改一個字就叮全公司好。
   */
  if (body.type && body.type !== 'INSERT')
    return NextResponse.json({ ok: true, skipped: 'not insert' });

  const { data: people } = await admin
    .from('profiles').select('id').eq('active', true);
  const userIds = (people ?? [])
    .map((p) => p.id as string)
    .filter((id) => id !== rec.created_by);

  if (userIds.length === 0)
    return NextResponse.json({ ok: true, skipped: 'no recipients' });

  const wanted = await filterByPref(admin, userIds, 'board');
  if (wanted.length === 0)
    return NextResponse.json({ ok: true, skipped: 'all opted out' });

  /*
   * ★★ 標題寫「新的活動：團聚」，內文寫時間與名稱。
   *   反過來的話（標題放名稱）,手機上一排通知看下來全是店名,
   *   分不出哪一則是開會哪一則是聚餐。
   *
   * ★ `all_day` 已停用（migration_265）,新的列一律 false ——
   *   但舊的列可能是 true,所以這裡還是照它決定畫不畫時間。
   */
  const when = fmtEventWhen(rec.starts_at, !rec.all_day);
  const r = await sendToUsers(admin, wanted, {
    title: `新的活動：${kindLabel(rec.kind)}`,
    body: `${when}・${rec.title ?? ''}`.replace(/・$/, ''),
    url: '/board?tab=events',
    kind: 'board',
    /* ★ tag 帶 id —— 同一場活動重複推的話會蓋掉舊的那則,不會疊兩條 */
    tag: 'board-ev-' + rec.id,
  });
  return NextResponse.json({ ok: true, ...r });
}
