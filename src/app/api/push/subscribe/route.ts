import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import webpush from 'web-push';
import { initWebPush, pushConfigured } from '@/lib/push';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 儲存 / 移除這台裝置的推播訂閱。
 * 呼叫者必須帶自己的 access token,user_id 一律取自 token,不接受前端指定 ——
 * 否則任何人都能把訂閱掛到別人名下,代收別人的通知。
 */
export async function POST(req: Request) {
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'no service key' }, { status: 500 });

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
  const { data: userData } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { action, subscription } = body as {
    action?: string;
    subscription?: { endpoint: string; keys?: { p256dh: string; auth: string } };
  };

  /*
   * 測試發送。只發給**呼叫者自己**的訂閱 —— user_id 取自 token，
   * 前端指不了別人，所以這支不能被拿來騷擾同事。
   *
   * 【為什麼不走 sendToUsers】
   * 那支會先寫進 `notifications` 表（存底）。測試訊息不該出現在「新訊息」——
   * 那一頁的價值就是「這裡每一則都是真的發生過的事」。
   *
   * 也**不看 notification_prefs** —— 這是在測管道通不通，
   * 不是在發某一種通知。全部關掉的人一樣測得了。
   */
  if (action === 'test') {
    if (!pushConfigured())
      return NextResponse.json({ error: '伺服器沒有設定 VAPID 金鑰' }, { status: 500 });
    initWebPush();

    const { data: subs } = await admin.from('push_subscriptions')
      .select('endpoint, p256dh, auth').eq('user_id', user.id);
    if (!subs?.length)
      return NextResponse.json({ ok: true, sent: 0, subscriptions: 0 });

    const json = JSON.stringify({
      title: '測試通知',
      body: '看得到這一則，表示這台裝置收得到通知。',
      url: '/settings?tab=notify',
      // 固定 tag —— 連按五次只會留下一則，不會在通知匣塞成一排
      tag: 'push-test',
    });

    let sent = 0;
    const dead: string[] = [];
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, json);
        sent++;
      } catch (e: unknown) {
        // 順手清掉死掉的訂閱。測試是唯一會逐台試的時機
        const code = (e as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) dead.push(s.endpoint);
      }
    }));
    if (dead.length) await admin.from('push_subscriptions').delete().in('endpoint', dead);

    return NextResponse.json({ ok: true, sent, subscriptions: subs.length, removed: dead.length });
  }

  if (action === 'unsubscribe') {
    if (!subscription?.endpoint) return NextResponse.json({ error: '缺少 endpoint' }, { status: 400 });
    await admin.from('push_subscriptions').delete()
      .eq('endpoint', subscription.endpoint).eq('user_id', user.id);
    return NextResponse.json({ ok: true });
  }

  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth)
    return NextResponse.json({ error: '訂閱資料不完整' }, { status: 400 });

  // 同一台裝置重新授權會拿到同一個 endpoint,用它 upsert 避免長出重複列
  const { error } = await admin.from('push_subscriptions').upsert({
    user_id: user.id,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    user_agent: req.headers.get('user-agent') ?? null,
    fail_count: 0,
  }, { onConflict: 'endpoint' });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
