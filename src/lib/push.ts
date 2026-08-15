import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import { NOTIFY_DEFAULT, NOTIFY_KINDS, type NotifyKind } from './notify-kinds';

/**
 * Web Push 的共用送出層。
 *
 * 【為什麼要抽出來】
 * 原本這段邏輯只存在 /api/push/notify 裡（請款單核可）。現在有四種通知，
 * 各自複製一份的話，「404/410 要清掉死訂閱」這種規則就有四個版本 ——
 * 而其中一份忘了清，那些永遠推不出去的訂閱會一直留著，
 * 下次推播每一則都多花一次失敗的網路往返，而且不會有人發現。
 *
 * 【通知種類的文字在另一個檔】
 * 種類與標籤在 lib/notify-kinds —— 那支沒有任何 Node 相依，
 * client component 可以安全匯入。這支不行：頂層就 import 了 web-push。
 */
export type { NotifyKind };
export { NOTIFY_KINDS };

export type PushPayload = {
  title: string;
  body: string;
  /** 點通知要跳去哪一頁 */
  url: string;
  /**
   * 同一個 tag 的通知會互相取代，不會在通知匣裡疊成一排。
   * 批次匯入尤其重要 —— 早上同步兩次就該只留最新那一則。
   */
  tag: string;
  /**
   * 種類。存底時要記（「新訊息」分頁靠它顯示圖示與分類）。
   *
   * 選填是為了不動既有呼叫端 —— 沒帶的話存底照存，
   * 只是歸到 'orders'。少一個分類比少一則訊息好。
   */
  kind?: NotifyKind;
};

export type SendResult = { sent: number; removed: number; recipients: number; skipped?: string };

export function adminClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** 環境變數缺一不可。缺了要早點講清楚，不要等到推播靜靜失敗才發現。 */
export function pushConfigured(): boolean {
  return !!(process.env.SUPABASE_SERVICE_KEY
    && process.env.VAPID_PRIVATE_KEY
    && process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
}

export function initWebPush() {
  webpush.setVapidDetails(
    'mailto:service@oasisliving.tw',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
}

/**
 * 從一組候選人裡篩出「這種通知有開」的那些。
 *
 * 【為什麼用 left join 的語意而不是直接 eq】
 * 帳號理論上都有偏好列（migration_92 回填 + 新帳號觸發器），但如果哪天
 * 有一條路徑繞過去了，直接查 notification_prefs 會讓那個人**永遠收不到任何通知**，
 * 而且他在設定頁看到的開關是「開」的 —— 查不出原因。
 *
 * 所以查不到列時退回預設值：審核收、其餘不收（跟資料表的 default 一致）。
 */
export async function filterByPref(
  admin: SupabaseClient, userIds: string[], kind: NotifyKind,
): Promise<string[]> {
  if (!userIds.length) return [];
  const { data } = await admin
    .from('notification_prefs').select(`user_id, ${kind}`).in('user_id', userIds);

  const pref = new Map<string, boolean>();
  for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
    pref.set(String(r.user_id), !!r[kind]);
  }
  // 預設值集中在 notify-kinds，跟 migration_92 的 column default 對齊。
  // 在這裡寫死 `kind === 'approvals'` 的話，之後改預設要記得改兩個地方。
  return userIds.filter((id) => pref.get(id) ?? NOTIFY_DEFAULT[kind]);
}

/**
 * 真的送出去。
 *
 * 404 / 410 代表對方已解除安裝或關閉權限 —— 那種訂閱永遠不會再成功，
 * 留著只會讓之後每一則通知都多一次失敗的往返，所以直接刪掉。
 * 其他錯誤（網路抖動、推播服務暫時掛掉）不刪，下次還有機會。
 */
export async function sendToUsers(
  admin: SupabaseClient, userIds: string[], payload: PushPayload,
): Promise<SendResult> {
  if (!userIds.length) return { sent: 0, removed: 0, recipients: 0, skipped: 'no recipients' };

  /*
   * 先存底，再推播。
   *
   * 【為什麼順序不能反】
   * 推播是「錯過就沒了」—— 開會中、在開車、手機在充電、根本沒訂閱這台裝置。
   * 存底正是為了那些情況，所以它**不能取決於推播成不成功**。
   *
   * 下面那行「沒有訂閱就提早 return」尤其危險:一個從來沒開過推播權限的人
   * 會走到那裡就結束,而他才是最需要「新訊息」那一頁的人。
   *
   * 【為什麼吞掉錯誤】
   * 跟 notifyImport 同一個道理:存底失敗不該讓推播也不發。
   * 兩件事的價值各自獨立,一個掛了另一個還是要做。
   */
  try {
    await admin.from('notifications').insert(userIds.map((id) => ({
      user_id: id,
      kind: payload.kind ?? 'orders',
      title: payload.title,
      body: payload.body,
      url: payload.url,
    })));
  } catch (e) {
    console.error('[push] 存底失敗（推播照發）:', (e as Error).message);
  }

  const { data: subs } = await admin.from('push_subscriptions').select('*').in('user_id', userIds);
  if (!subs?.length) return { sent: 0, removed: 0, recipients: userIds.length, skipped: 'no subscriptions' };

  const json = JSON.stringify(payload);
  let sent = 0;
  const dead: string[] = [];

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, json);
      sent++;
    } catch (e: unknown) {
      const code = (e as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) dead.push(s.endpoint);
    }
  }));

  if (dead.length) await admin.from('push_subscriptions').delete().in('endpoint', dead);
  return { sent, removed: dead.length, recipients: userIds.length };
}

/**
 * 匯入完成後，從伺服器端發一則聚合通知。
 *
 * 【為什麼是聚合的一則，不是每筆一則】
 * 匯入是批次的：訂單每批 200 筆、評價每批 500 筆。每筆一則的話，
 * 早上同步抓到 30 筆訂單就是手機叮 30 下 —— 沒有人會留著那種通知。
 *
 * 【為什麼吞掉錯誤】
 * 匯入本身才是重點。推播掛掉不該讓匯入回報失敗，否則排程會以為資料沒進去
 * 而重跑一次。回傳值只給呼叫端記 log 用。
 */
export async function notifyImport(
  kind: Exclude<NotifyKind, 'approvals'>, title: string, body: string, url: string,
): Promise<SendResult | null> {
  try {
    if (!pushConfigured()) return null;
    initWebPush();
    const admin = adminClient();
    const { data } = await admin.from('profiles').select('id').eq('active', true);
    const ids = await filterByPref(admin, (data ?? []).map((p) => p.id), kind);
    // tag 帶日期：同一天重複同步會取代前一則，不會疊成一排
    return await sendToUsers(admin, ids, {
      title, body, url, kind, tag: `${kind}-${new Date().toISOString().slice(0, 10)}`,
    });
  } catch (e) {
    console.error('[push] notifyImport 失敗（匯入本身不受影響）:', (e as Error).message);
    return null;
  }
}
