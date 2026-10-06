import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { parseOtaEmail, matchEstate, matchProperty, otaOrderRow, type OtaEmailBody } from '@/lib/ota-email';

/**
 * OTA 訂房通知信 → 訂單（Make.com 的 HTTP 模組打這裡；2026-10-06 David：「看信，然後導入訂單」）。
 *
 *   POST /api/import/ota-email
 *   Header  x-import-key: <IMPORT_KEY>（跟其他 /api/import/* 同一把）
 *   Body    { source, ota_no, checkin, checkout, property, unit, guest?, amount?, email_id }
 *
 * ★★ 只新增、不覆蓋（lib/ota-email.ts 檔頭）。已存在 → 200 + action 'exists'。
 * ★ 錯誤回 4xx ＋ 一句話 —— Make 那邊「Evaluate all states as errors」會把它顯示在模組上。
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!process.env.IMPORT_KEY || req.headers.get('x-import-key') !== process.env.IMPORT_KEY)
    return NextResponse.json({ ok: false, error: 'unauthorized —— x-import-key 不對' }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ ok: false, error: 'SUPABASE_SERVICE_KEY not configured' }, { status: 500 });

  let body: OtaEmailBody;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'body 不是 JSON' }, { status: 400 }); }
  const parsed = parseOtaEmail(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 422 });
  const v = parsed.v;

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);

  // 已存在就不動（爬蟲先到、或同一封信跑兩次）
  const { data: exist } = await supabase.from('orders').select('id, source, imported_via').eq('order_key', v.order_key).maybeSingle();
  if (exist) return NextResponse.json({ ok: true, action: 'exists', order_id: exist.id, order_key: v.order_key,
    message: `訂單 ${v.order_key} 已經在系統裡（${exist.imported_via ?? 'manual'}），沒有改動` });

  const [{ data: estates }, { data: props }] = await Promise.all([
    supabase.from('estates').select('id, name').eq('active', true),
    supabase.from('properties').select('id, name, estate_id'),
  ]);
  const estate = matchEstate(estates ?? [], v.estate_name);
  const prop = matchProperty((props ?? []) as { id: string; name: string; estate_id: string | null }[], estate?.id ?? null, v.property_raw);

  const row = otaOrderRow(v, estate?.id ?? null, prop?.id ?? null);
  const { data: ins, error } = await supabase.from('orders').insert(row).select('id').single();
  if (error) {
    // 唯一鍵撞到 ＝ 兩封信幾乎同時進來，第二封當作已存在
    if (error.code === '23505') return NextResponse.json({ ok: true, action: 'exists', order_key: v.order_key, message: '剛剛已經建過了' });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    ok: true, action: 'inserted', order_id: ins.id, order_key: v.order_key,
    estate: estate?.name ?? null, property: prop?.name ?? null,
    warnings: [
      !estate ? `物業「${v.estate_name ?? ''}」對不到 —— 訂單建了，物業空著` : '',
      !prop ? `房源「${v.property_raw ?? ''}」對不到 —— 訂單建了，房源只留文字` : '',
      !v.amount ? '金額 0，等爬蟲同步' : '',
    ].filter(Boolean),
    message: `已建立訂單 ${v.order_key}（${v.checkin}～${v.checkout}，${v.nights} 晚）`,
  });
}
