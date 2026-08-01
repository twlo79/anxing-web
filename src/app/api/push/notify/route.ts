import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import webpush from 'web-push';

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
 */
export async function POST(req: Request) {
  const key = process.env.PUSH_KEY;
  if (!key) return NextResponse.json({ error: 'no push key' }, { status: 500 });
  if (req.headers.get('x-push-key') !== key)
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  if (!process.env.SUPABASE_SERVICE_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
    return NextResponse.json({ error: 'push not configured' }, { status: 500 });

  webpush.setVapidDetails(
    'mailto:service@oasisliving.tw',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

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

  const { data: subs } = await admin.from('push_subscriptions').select('*').in('user_id', userIds);
  if (!subs?.length) return NextResponse.json({ ok: true, skipped: 'no subscriptions' });

  const payload = JSON.stringify({ title, body: bodyText, url: '/purchases', tag: 'pr-' + rec.id });
  let sent = 0;
  const dead: string[] = [];

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      );
      sent++;
    } catch (e: unknown) {
      // 404 / 410 = 對方已解除安裝或關閉權限,這種訂閱永遠不會再成功,直接清掉
      const code = (e as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) dead.push(s.endpoint);
    }
  }));

  if (dead.length) await admin.from('push_subscriptions').delete().in('endpoint', dead);

  return NextResponse.json({ ok: true, sent, removed: dead.length, recipients: userIds.length });
}
