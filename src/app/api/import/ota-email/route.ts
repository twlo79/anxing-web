import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { parseOtaEmail, matchEstate, matchProperty, otaOrderRow, otaCancelDecision, otaModifyDecision, type OtaEmailBody } from '@/lib/ota-email';

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
  /*
   * ══ 取消通知信（event: 'cancel'，2026-10-21）══ 規則在 lib/ota-email.ts 的 otaCancelDecision
   *   Make 的取消那一條：Body 多帶 "event": "cancel"，其餘欄位跟訂房那條一樣（只有 ota_no 是必填）
   */
  if ((body.event ?? '').trim().toLowerCase() === 'cancel') {
    const key = (body.ota_no ?? '').trim();
    if (!key) return NextResponse.json({ ok: false, error: 'ota_no（訂房編號）是空的 —— Text parser 沒抓到' }, { status: 422 });
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);
    const { data: ex } = await sb.from('orders').select('id, source, paid, checkin, checkout, note').eq('order_key', key).maybeSingle();
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const d = otaCancelDecision(ex as any, body, today);
    if (d.kind === 'not_found') return NextResponse.json({ ok: true, action: 'not_found', order_key: key, message: `系統裡沒有 ${key}，不用作廢` });
    if (d.kind === 'skip') return NextResponse.json({ ok: true, action: 'skip', order_key: key, message: `${key}：${d.reason}` });
    if (d.kind === 'attention') return NextResponse.json({ ok: true, action: 'attention', order_key: key, order_id: ex!.id, message: `${key}：${d.reason}` });
    const { error } = await sb.from('orders').update(d.patch).eq('id', ex!.id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, action: 'cancelled', order_key: key, order_id: ex!.id, warnings: d.warnings,
      message: `已把 ${key} 標成 Airbnb 取消（金額 0）` });
  }

  /*
   * ══ 修改通知信（event: 'modify'，2026-10-21）══ 規則在 lib/ota-email.ts 的 otaModifyDecision
   *   系統裡沒有這張 → 往下走一般建單（用修改後的資料）
   */
  if ((body.event ?? '').trim().toLowerCase() === 'modify') {
    const key = (body.ota_no ?? '').trim();
    if (!key) return NextResponse.json({ ok: false, error: 'ota_no（訂房編號）是空的 —— Text parser 沒抓到' }, { status: 422 });
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);
    const { data: ex } = await sb.from('orders').select('id, source, amount, checkin, checkout, note, move_chain').eq('order_key', key).maybeSingle();
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const d = otaModifyDecision(ex as any, body, today);
    if (d.kind === 'bad') return NextResponse.json({ ok: false, error: d.error }, { status: 422 });
    if (d.kind === 'skip') return NextResponse.json({ ok: true, action: 'skip', order_key: key, message: `${key}：${d.reason}` });
    if (d.kind === 'attention') return NextResponse.json({ ok: true, action: 'attention', order_key: key, order_id: ex!.id, message: `${key}：${d.reason}` });
    if (d.kind === 'update') {
      const { error } = await sb.from('orders').update(d.patch).eq('id', ex!.id);
      if (error) return NextResponse.json({ ok: false, error: `改不動（可能那個月已關帳）：${error.message}` }, { status: 500 });
      return NextResponse.json({ ok: true, action: 'modified', order_key: key, order_id: ex!.id, changes: d.changes, warnings: d.warnings,
        message: `已更新 ${key}：${d.changes.join('・')}` });
    }
    // not_found → 下面照一般訂房信建一張
  }

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
