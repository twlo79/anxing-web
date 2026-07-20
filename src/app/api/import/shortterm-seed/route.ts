import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import seed from '@/data/shortterm_orders.json';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SRC_MAP: Record<string, string> = { partner: 'airbnb', airbnb_cancelled: 'oneoff' };

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
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'no service key' }, { status: 500 });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);

  const { data: estates } = await supabase.from('estates').select('id, name');
  const estateByName = Object.fromEntries((estates ?? []).map((e) => [e.name, e.id]));
  const { data: props } = await supabase.from('properties').select('id, name, estate_id, airbnb_listing_id, estates(name)');
  const propList = (props ?? []).map((p: any) => ({ id: p.id, name: p.name, estate: p.estates?.name, estateId: p.estate_id, listingId: p.airbnb_listing_id }));

  const items = seed as any[];
  const unmatchedProp: Record<string, number> = {};
  const records = items.map((o) => {
    const source = SRC_MAP[o.source] ?? o.source ?? 'private';
    const estateId = o.estate_name ? estateByName[o.estate_name] ?? null : null;
    let propertyId: string | null = null;
    if (o.property_raw) {
      const rawUnit = normUnit(o.property_raw);
      const cand = propList.filter((p) => p.estate === o.estate_name);
      let hit = cand.find((p) => p.name === o.property_raw) || cand.find((p) => normUnit(p.name) === rawUnit);
      if (!hit && rawUnit) hit = cand.find((p) => normUnit(p.name).includes(rawUnit) || rawUnit.includes(normUnit(p.name)));
      if (hit) propertyId = hit.id;
      else unmatchedProp[`${o.estate_name || ''}/${o.property_raw}`] = (unmatchedProp[`${o.estate_name || ''}/${o.property_raw}`] || 0) + 1;
    }
    const n = o.nights ?? nights(o.checkin, o.checkout);
    return {
      order_key: String(o.order_key), source, estate_id: estateId, property_id: propertyId,
      property_raw: o.property_raw || null, guest_name: o.guest_name || null,
      checkin: o.checkin, checkout: o.checkout || null, nights: n,
      amount: o.amount ?? 0, deposit: o.deposit ?? 0, account: o.account || null,
      note: o.note || null, imported_via: o.imported_via || 'excel', paid: o.paid ?? false,
    };
  });

  let done = 0;
  for (let i = 0; i < records.length; i += 500) {
    const { error } = await supabase.from('orders').upsert(records.slice(i, i + 500), { onConflict: 'order_key' });
    if (error) return NextResponse.json({ error: error.message, done }, { status: 500 });
    done += Math.min(500, records.length - i);
  }
  const unmatchedTop = Object.entries(unmatchedProp).sort((a, b) => b[1] - a[1]).slice(0, 30);
  return NextResponse.json({ imported: records.length, unmatchedCount: Object.values(unmatchedProp).reduce((a, b) => a + b, 0), unmatchedTop });
}
