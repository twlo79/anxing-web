import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

/**
 * 自動關帳的排程端點（migration_223）。
 *
 * 每天由 GitHub Actions 打一次（`.github/workflows/close-period.yml`）。
 *
 * ============================================================
 * 【★★ 為什麼不是 pg_cron】
 *
 * 這個專案的 Supabase **沒有裝 pg_cron**（2026-09-07 查過）。
 * 而已經有一套每天在跑的 GitHub Actions（備份），
 * 掛在同一套基礎設施上比多裝一個擴充穩。
 *
 * ============================================================
 * 【★★★ 判斷全部在資料庫裡，這一支只負責「叫它」】
 *
 * `close_due_periods()` 自己判斷「今天 ≥ 5 號、上個月關了沒、
 * 有沒有被人手動打開過」。這裡**不重複那套判斷** ——
 * 兩邊各寫一次的話，改規則時漏掉一邊不會有任何地方報錯
 * （CLAUDE.md:同一條規則在三個地方各寫一次）。
 *
 * ★ 所以這支每天打都可以，甚至一天打十次也沒事:
 *   函式是冪等的，關過了就回「已經關過了」。
 *
 * ============================================================
 * 【★★ 為什麼走 service key】
 *
 * 排程沒有登入身分 —— `auth.uid()` 是 null，
 * 而 `period_lock` 的 policy 要求 `current_role_of()` 是會計以上。
 * 走 RLS 的話**一列都寫不進去而且不會報錯**（回成功、影響 0 列）。
 *
 * 跟現有的六支 import 端點同一個模式:service key ＋ `x-import-key` 自己擋。
 */

export async function POST(req: Request) {
  const key = req.headers.get('x-import-key');
  if (!key || key !== process.env.IMPORT_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !svc) {
    return NextResponse.json({ error: 'missing supabase env' }, { status: 500 });
  }

  const supabase = createClient(url, svc, { auth: { persistSession: false } });
  const { data, error } = await supabase.rpc('close_due_periods');
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  /*
   * ★ 回傳做了什麼，不是只回 ok。
   *   排程的 log 只有這一行 —— 「ok」的話沒有人看得出來
   *   它到底關了沒、還是因為還沒到 5 號而跳過
   *   （跟 migration 自檢要「判定」不要「參考值」同一個道理）。
   */
  const rows = (data ?? []) as { ym: string; action: string }[];
  return NextResponse.json({
    ok: true,
    result: rows,
    summary: rows.map((r) => `${r.ym}：${r.action}`).join('；') || '（沒有回傳）',
  });
}

/** ★ GET 只回說明，不做事 —— 免得瀏覽器一開就關帳 */
export async function GET() {
  return NextResponse.json({
    hint: '這支要用 POST，而且要帶 x-import-key。每天由 GitHub Actions 呼叫一次。',
  });
}
