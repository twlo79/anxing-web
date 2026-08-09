import { NextResponse } from 'next/server';
import {
  adminClient, filterByPref, initWebPush, pushConfigured, sendToUsers,
  type NotifyKind, type PushPayload,
} from '@/lib/push';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';   // web-push 需要 Node 環境,不能跑在 edge

/**
 * 通用推播端點：把一則已經寫好的通知發給「這種通知有開」的所有人。
 *
 * 【跟 /api/push/notify 的分工】
 *   notify     只服務請款單的 webhook。收件人由狀態機決定（誰還沒投票、誰是提交者），
 *              那段邏輯只有請款單用得到,混進通用端點會讓兩邊都難改。
 *   broadcast  給「一件事發生了,想知道的人都通知」用的：新訂單、新評價、新清潔記錄。
 *              呼叫端負責寫好標題內容,這裡只負責篩人與送出。
 *
 * 【誰會呼叫】
 *   - migration_92 的 trg_orders_notify（手動 key 的私下訂單,經 pg_net）
 *   - 三支匯入 API 其實直接用 lib/push 的 notifyImport(),不繞這個 HTTP 端點 ——
 *     同一個行程裡多打一次自己的 HTTP 是沒有意義的往返。
 *     這個端點存在是為了資料庫觸發器,那邊沒有別的方式呼叫應用程式碼。
 */
export async function POST(req: Request) {
  const key = process.env.PUSH_KEY;
  if (!key) return NextResponse.json({ error: 'no push key' }, { status: 500 });
  if (req.headers.get('x-push-key') !== key)
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  if (!pushConfigured())
    return NextResponse.json({ error: 'push not configured' }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const kind = body.kind as NotifyKind | undefined;

  // 種類要白名單。少了這道,body.kind 會被當成欄位名接進 select() ——
  // 那是 SQL 注入的形狀,而且錯誤訊息會長得像查詢失敗,查不到根因。
  if (!kind || !['orders', 'approvals', 'reviews', 'cleaning'].includes(kind))
    return NextResponse.json({ error: 'bad kind' }, { status: 400 });
  if (!body.title || !body.body)
    return NextResponse.json({ error: 'title/body required' }, { status: 400 });

  const payload: PushPayload = {
    title: String(body.title),
    body: String(body.body),
    url: String(body.url ?? '/'),
    tag: String(body.tag ?? kind),
  };

  initWebPush();
  const admin = adminClient();

  const { data } = await admin.from('profiles').select('id').eq('active', true);
  let ids = (data ?? []).map((p) => p.id);

  /*
   * 排除觸發這件事的人本人。
   *
   * 他剛按下「新增訂單」,不需要系統再叮他一次告訴他他做了什麼。
   * 呼叫端沒帶 actor 就不排除 —— 爬蟲匯入沒有「本人」可言。
   */
  if (body.actor_id) ids = ids.filter((id) => id !== body.actor_id);

  ids = await filterByPref(admin, ids, kind);
  const r = await sendToUsers(admin, ids, payload);
  return NextResponse.json({ ok: true, kind, ...r });
}
