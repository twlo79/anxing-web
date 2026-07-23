import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CORS = {
  'Access-Control-Allow-Origin': 'https://www.airbnb.com',
  'Access-Control-Allow-Headers': 'content-type, x-import-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

const num = (v: any) => {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : n;
};

// 傳入每筆: { code, listingId, guest, start, end, nights, statusKey, earnings, cohost }
export async function POST(req: Request) {
  if (!process.env.IMPORT_KEY || req.headers.get('x-import-key') !== process.env.IMPORT_KEY)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'no service key' }, { status: 500, headers: CORS });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);

  const items: any[] = (await req.json()).reservations ?? [];
  if (!items.length) return NextResponse.json({ upserted: 0 }, { headers: CORS });

  // listing_id -> property
  const { data: props } = await supabase.from('properties').select('id, name, estate_id, airbnb_listing_id');
  const byListing: Record<string, any> = {};
  (props ?? []).forEach((p) => { if (p.airbnb_listing_id) byListing[String(p.airbnb_listing_id)] = p; });

  const unmatched: Record<string, number> = {};
  const skipped: string[] = [];
  const cat = { airbnb: 0, oneoff: 0 };
  const records: any[] = [];

  for (const m of items) {
    const cancelled = /cancel/i.test(String(m.statusKey || ''));
    const earn = num(m.earnings);
    const cohost = Math.abs(num(m.cohost));
    let source: string | null = null, amount = 0, fee_type: string | null = null, note: string | null = null;
    if (cancelled) {
      if (earn > 0) { source = 'oneoff'; amount = earn; fee_type = '取消費'; note = 'Airbnb 取消收入'; }
      else { skipped.push(m.code); continue; }
    } else {
      if (earn > 0) { source = 'airbnb'; amount = earn; }
      else if (cohost > 0) { source = 'airbnb'; amount = cohost; note = '搭檔收款(Co-host payout)'; }
      else { skipped.push(m.code); continue; }
    }
    const prop = m.listingId ? byListing[String(m.listingId)] : null;
    if (!prop) { unmatched[String(m.listingId)] = (unmatched[String(m.listingId)] || 0) + 1; continue; }
    records.push({
      order_key: String(m.code), source, estate_id: prop.estate_id, property_id: prop.id, property_raw: prop.name,
      guest_name: m.guest || '(unknown)', checkin: m.start, checkout: m.end, nights: m.nights ?? null,
      amount, fee_type, note, imported_via: 'auto',
    });
    (cat as any)[source]++;
  }

  // 去重: 以 order_key(=confirmation_code) 比對既有。既有→只更新金額/來源/日期等,保留人工欄位(paid/deposit/account/押金/外幣/移房)
  const codes = records.map((r) => r.order_key);
  const existRows: any[] = [];
  for (let i = 0; i < codes.length; i += 400) {
    const { data } = await supabase.from('orders').select('order_key').in('order_key', codes.slice(i, i + 400));
    existRows.push(...(data ?? []));
  }
  const existing = new Set(existRows.map((e) => e.order_key));

  let inserted = 0, updated = 0;
  const toInsert = records.filter((r) => !existing.has(r.order_key));
  const toUpdate = records.filter((r) => existing.has(r.order_key));
  for (let i = 0; i < toInsert.length; i += 200) {
    const { error } = await supabase.from('orders').insert(toInsert.slice(i, i + 200));
    if (error) return NextResponse.json({ error: error.message, inserted }, { status: 500, headers: CORS });
    inserted += Math.min(200, toInsert.length - i);
  }
  for (const r of toUpdate) {
    const { error } = await supabase.from('orders')
      .update({ source: r.source, estate_id: r.estate_id, property_id: r.property_id, property_raw: r.property_raw,
                guest_name: r.guest_name, checkin: r.checkin, checkout: r.checkout, nights: r.nights, amount: r.amount, fee_type: r.fee_type })
      .eq('order_key', r.order_key);
    if (!error) updated++;
  }

  return NextResponse.json({
    received: items.length, inserted, updated, byCategory: cat,
    dedupedExisting: updated, unmatched, skippedNoRevenue: skipped.length,
  }, { headers: CORS });
}
