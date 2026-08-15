import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { fetchIn } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-import-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

// 來源正規化:搭檔併 airbnb、取消歸一次性其他收入
const SRC_MAP: Record<string, string> = { partner: 'airbnb', airbnb_cancelled: 'oneoff' };

// 房號正規化(與清潔一致)
function normUnit(s: string) {
  return (s || '').toUpperCase()
    .replace(/開封|時兆|正隆|亞曼尼|台視|JPR|RMJ|NEW|舊|整層|（[^）]*）|\([^)]*\)|房|樓|層|棟|\s/g, '')
    .replace(/A0*(\d)/g, 'A$1').replace(/B0*(\d)/g, 'B$1');
}
function nights(ci: string, co: string) {
  return Math.max(0, Math.round((new Date(co).getTime() - new Date(ci).getTime()) / 86400000));
}

export async function POST(req: Request) {
  if (!process.env.IMPORT_KEY || req.headers.get('x-import-key') !== process.env.IMPORT_KEY)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'SUPABASE_SERVICE_KEY not configured' }, { status: 500, headers: CORS });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);
  const body = await req.json();
  const items: any[] = body.orders ?? [];
  if (!items.length) return NextResponse.json({ inserted: 0, updated: 0 }, { headers: CORS });

  const { data: estates } = await supabase.from('estates').select('id, name');
  const estateByName = Object.fromEntries((estates ?? []).map((e) => [e.name, e.id]));
  const { data: props } = await supabase.from('properties').select('id, name, estate_id, airbnb_listing_id, estates(name)');
  const propList = (props ?? []).map((p: any) => ({ id: p.id, name: p.name, estate: p.estates?.name, estateId: p.estate_id, listingId: p.airbnb_listing_id }));
  /*
   * listing_id → 房源走 listing_property_map（migration_127）。
   * 一間房可以有多個歷史編號 —— properties.airbnb_listing_id 只放得下一個,
   * 讀那個欄位的話舊編號的訂單會對不到房源,而**整筆不會進系統**。
   */
  const { data: maps } = await supabase.from('listing_property_map').select('listing_id, property_id');
  const byId = Object.fromEntries(propList.map((p) => [p.id, p]));
  const propByListingId = Object.fromEntries(
    (maps ?? []).map((m) => [String(m.listing_id), byId[m.property_id]]).filter(([, p]) => p));

  const unmatchedProp: Record<string, number> = {};
  const records = items.map((o) => {
    let estateId = o.estate_name ? estateByName[o.estate_name] ?? null : null;
    let propertyId: string | null = null;
    // 優先:Airbnb listing_id 直接對應
    if (o.airbnb_listing_id && propByListingId[String(o.airbnb_listing_id)]) {
      const hitP = propByListingId[String(o.airbnb_listing_id)];
      propertyId = hitP.id;
      if (!estateId) estateId = hitP.estateId;
    } else {
      const rawUnit = normUnit(o.property_raw || '');
      const cand = propList.filter((p) => p.estate === o.estate_name);
      let hit = cand.find((p) => normUnit(p.name) === rawUnit);
      if (!hit && rawUnit) hit = cand.find((p) => normUnit(p.name).includes(rawUnit) || rawUnit.includes(normUnit(p.name)));
      if (hit) propertyId = hit.id;
      else if (o.property_raw || o.airbnb_listing_id) unmatchedProp[`${o.estate_name || ''}/${o.property_raw || o.airbnb_listing_id}`] = (unmatchedProp[`${o.estate_name || ''}/${o.property_raw || o.airbnb_listing_id}`] || 0) + 1;
    }
    const n = o.nights ?? nights(o.checkin, o.checkout);
    return {
      order_key: String(o.order_key),
      source: SRC_MAP[o.source] ?? o.source ?? 'private',
      estate_id: estateId,
      property_id: propertyId,
      property_raw: o.property_raw || null,
      guest_name: o.guest_name || null,
      checkin: o.checkin,
      checkout: o.checkout,
      nights: n,
      amount: o.amount ?? 0,
      deposit: o.deposit ?? 0,
      account: o.account || null,
      note: o.note || null,
      imported_via: o.imported_via || 'excel',
      paid: o.paid ?? false,
    };
  });

  /*
   * 「哪些已經存在」—— 撈不全的話 inserted 會虛報。
   * 寫入是 upsert onConflict order_key,所以不會產生重複資料,
   * 但這個數字會被拿去發推播通知,虛報等於叮一則假的。
   */
  const keys = records.map((r) => r.order_key);
  const { rows: existing } = await fetchIn<{ order_key: string }>(
    keys,
    (chunk, f, t) => supabase.from('orders').select('order_key').in('order_key', chunk).range(f, t));
  const has = new Set(existing.map((e) => e.order_key));
  const inserted = keys.filter((k) => !has.has(k)).length;

  for (let i = 0; i < records.length; i += 500) {
    const { error } = await supabase.from('orders').upsert(records.slice(i, i + 500), { onConflict: 'order_key' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS });
  }
  return NextResponse.json({ inserted, updated: records.length - inserted, total: records.length, unmatchedProp }, { headers: CORS });
}
