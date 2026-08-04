import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * 健康檢查。不需要金鑰 —— 部署腳本要在拿不到任何憑證的情況下呼叫它。
 *
 * 【為什麼需要這支】
 * 2026-08-04 全站 503 了幾小時，而所有訊號都是綠的：
 * 本機 build 過、pm2 顯示 online、log 印著 ✓ Ready in 898ms。
 * 唯一的線索是 pm2 的重啟次數累積到 79，沒有人在看那個數字。
 *
 * 當時真正的狀況是：CI 的 build 失敗 → .next 被寫壞一半 → 服務起得來但
 * 一有請求就找不到模組 → 崩潰 → pm2 重啟 → 再崩潰。
 *
 * 「程序活著」和「服務可用」是兩件事。這支驗的是後者：
 * 它會真的算繪一個頁面之外的請求路徑，並且真的碰一次資料庫。
 *
 * 【刻意不回傳任何內部資訊】
 * 這支是公開的，所以只回狀態，不回版本號、不回錯誤細節、不回環境變數。
 * 出錯時 `db: false` 就夠部署腳本判斷了，細節去看 pm2 logs。
 */
export async function GET() {
  const out: { ok: boolean; db: boolean; at: string } = {
    ok: false,
    db: false,
    at: new Date().toISOString(),
  };

  try {
    // 只有 anon key 也能做這件事 —— 健康檢查不該需要 service key，
    // 那把鑰匙給了就能繞過所有 RLS，不值得為了一個 ping 冒險。
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    // estates 是最小、最穩定的表，而且 RLS 對已登入者以外一律擋下 ——
    // 這裡拿到 0 筆是正常的，我們要的只是「連得上、查得動」。
    const { error } = await supabase.from('estates').select('id', { head: true, count: 'exact' });
    out.db = !error;
  } catch {
    out.db = false;
  }

  out.ok = out.db;
  return NextResponse.json(out, { status: out.ok ? 200 : 503 });
}
