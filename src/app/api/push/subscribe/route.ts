import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

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
