import { NextResponse } from 'next/server';
import { adminClient, filterByPref, initWebPush, pushConfigured, sendToUsers } from '@/lib/push';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';   // web-push 需要 Node 環境,不能跑在 edge

/**
 * 由 Supabase Database Webhook 呼叫，在請款單狀態變動時推播。
 *
 * 收件人規則：
 *   pending   → 該投票而還沒投的人（manager / super_admin），排除提交者本人
 *   rejected  → 提交者
 *   approved  → 提交者
 *
 * 排除提交者是為了降噪：他剛按下送出，不需要系統再通知他一次。
 * 副作用是主管送自己的單時不會收到「該投票了」的提醒 —— 他在列表上看得到。
 *
 * 【migration_92 之後多了一層】
 * 算出收件人之後，還要再過一次「這個人的審核通知有沒有開」。
 * 送出與清死訂閱的邏輯搬到 lib/push —— 四種通知共用同一份，
 * 各自複製的話「404/410 要刪掉」這種規則會有四個版本，而漏掉的那份不會報錯。
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
  const old = body.old_record ?? null;
  if (!rec?.id) return NextResponse.json({ error: 'no record' }, { status: 400 });

  // 狀態沒變就不推,否則每次改採購日、改備註都會叮一次
  if (old && old.status === rec.status && old.manager_approved_at === rec.manager_approved_at
      && old.admin_approved_at === rec.admin_approved_at)
    return NextResponse.json({ ok: true, skipped: 'no status change' });

  const amount = Math.round(Number(rec.total_amount) || 0).toLocaleString();
  let userIds: string[] = [];
  let title = '';
  let bodyText = '';

  if (rec.status === 'pending') {
    const needRoles: string[] = [];
    if (!rec.manager_approved_at) needRoles.push('manager');
    if (!rec.admin_approved_at) needRoles.push('super_admin');
    if (needRoles.length === 0) return NextResponse.json({ ok: true, skipped: 'both voted' });

    const { data } = await admin.from('profiles').select('id').in('role', needRoles).eq('active', true);
    userIds = (data ?? []).map((p) => p.id).filter((id) => id !== rec.requester_id);
    title = '有請款單待核可';
    bodyText = `${rec.req_no}・$${amount}`;
  } else if (rec.status === 'rejected') {
    userIds = [rec.requester_id];
    title = '請款單被駁回';
    bodyText = `${rec.req_no}${rec.reject_reason ? '・' + rec.reject_reason : ''}`;
  } else if (rec.status === 'approved') {
    userIds = [rec.requester_id];
    title = '請款單已核可';
    bodyText = `${rec.req_no}・$${amount}`;
  } else {
    return NextResponse.json({ ok: true, skipped: 'status ' + rec.status });
  }

  if (userIds.length === 0) return NextResponse.json({ ok: true, skipped: 'no recipients' });

  // 再過一次個人偏好（migration_92）。沒有偏好列的人退回預設「收」——
  // 那是上線前的既有行為,不能因為少一列資料就讓人靜靜地收不到核可通知。
  const wanted = await filterByPref(admin, userIds, 'approvals');
  if (wanted.length === 0) return NextResponse.json({ ok: true, skipped: 'all opted out' });

  const r = await sendToUsers(admin, wanted, {
    title, body: bodyText, url: '/purchases', tag: 'pr-' + rec.id,
  });
  return NextResponse.json({ ok: true, ...r });
}
