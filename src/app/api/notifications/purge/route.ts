import { NextResponse } from 'next/server';
import { adminClient } from '@/lib/push';

/**
 * 清掉七天前的通知存底。**每週日跑一次**（2026-08-15 使用者指定）。
 *
 * ============================================================
 * 【這支不管顯示，只管表不要無限長大】
 *
 * 「新訊息」那一頁本來就只撈七天內 —— 顯示範圍不依賴這支跑不跑。
 * 分開的理由：只靠週日清的話，週六會看到十三天份，
 * 而「留一週」就變成一個看心情的數字。
 *
 * 反過來，只靠讀取過濾的話資料永遠不會被刪掉：十個人、一天十則，
 * 一年就是三萬多列躺在那裡，沒有人看得到、也沒有人會想到要清。
 *
 * ============================================================
 * 【為什麼要金鑰】
 * 這是刪除。沒有金鑰的話任何人打一下網址就能把全公司的訊息清光，
 * 而那個動作不會留下任何痕跡（被刪的東西本來就是要消失的）。
 */
export async function POST(req: Request) {
  if (!process.env.IMPORT_KEY || req.headers.get('x-import-key') !== process.env.IMPORT_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = adminClient();
  const { data, error } = await admin.rpc('purge_old_notifications');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const n = (data as { item: string; n: number }[] | null)?.[0]?.n ?? 0;
  return NextResponse.json({ ok: true, purged: n });
}
