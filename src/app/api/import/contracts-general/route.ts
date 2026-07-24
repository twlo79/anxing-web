import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import seed from '@/data/general_contracts.json';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TYPE_SRC: Record<string, string> = { longterm: 'longterm', company: 'company', office: 'office' };
const STEP_OF: Record<string, number> = { monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 };

export async function POST(req: Request) {
  if (!process.env.IMPORT_KEY || req.headers.get('x-import-key') !== process.env.IMPORT_KEY)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'no service key' }, { status: 500 });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);

  const rows = (seed as any[]).map((r) => ({ ...r, room_final: r.room_final || r.room }));
  const estateNames = Array.from(new Set(rows.map((r) => r.estate)));

  // 1) 解析 / 建立 estate
  const estId: Record<string, string> = {};
  for (const name of estateNames) {
    let { data: e } = await supabase.from('estates').select('id').eq('name', name).maybeSingle();
    if (!e) { const { data: ne } = await supabase.from('estates').insert({ name }).select('id').single(); e = ne; }
    if (!e) return NextResponse.json({ error: `estate 建立失敗: ${name}` }, { status: 500 });
    estId[name] = e.id;
  }

  // 2) 建缺少的房源 (room_final)
  let newProps = 0;
  for (const name of estateNames) {
    const eid = estId[name];
    const { data: props } = await supabase.from('properties').select('name').eq('estate_id', eid);
    const have = new Set((props ?? []).map((p: any) => p.name));
    const want = Array.from(new Set(rows.filter((r) => r.estate === name).map((r) => r.room_final)));
    const add = want.filter((r) => !have.has(r)).map((n) => ({ name: n, estate_id: eid }));
    if (add.length) { await supabase.from('properties').insert(add); newProps += add.length; }
  }

  // 3) 清掉這些 estate 既有契約(正隆等其他 estate 不動),再灌
  for (const name of estateNames) await supabase.from('contracts').delete().eq('estate_id', estId[name]);
  const contracts = rows.map((r) => ({
    estate_id: estId[r.estate], room: r.room_final, property_raw: r.room_final,
    type: r.type, tenant_name: r.tenant, phone: r.phone || null, cadence: r.cadence,
    monthly_rent: r.monthly_rent || 0, amount_per_period: r.amount_per_period || 0, deposit: r.deposit || 0,
    start_date: r.start || '2026-01-01', end_date: r.end || '2026-12-31',
    first_payment_date: r.first_payment_date || null, pay_day: r.pay_day ?? null,
    account: null, note: null, active: true, name: `${r.tenant ?? ''}-${r.room_final}`,
  }));
  let inserted = 0;
  for (let i = 0; i < contracts.length; i += 20) {
    const { error } = await supabase.from('contracts').insert(contracts.slice(i, i + 20));
    if (error) return NextResponse.json({ error: error.message, inserted }, { status: 500 });
    inserted += Math.min(20, contracts.length - i);
  }

  // 4) 觸發器已產生 source=longterm 的每月 order,依類別改 source(company/office) 讓營收分開認列
  let srcUpdated = 0;
  for (const r of rows) {
    const src = TYPE_SRC[r.type] || 'longterm';
    if (src === 'longterm') continue;
    const { data: los } = await supabase.from('orders').update({ source: src }).like('order_key', `LT_${r.room_final}_%`).select('id');
    srcUpdated += (los ?? []).length;
  }

  // 5) 依「已收至」以「期」標記已收 (paid_at 用首繳日)
  const monthsBetween = (a: string, b: string) => {
    const [ay, am] = a.slice(0, 7).split('-').map(Number);
    const [by, bm] = b.slice(0, 7).split('-').map(Number);
    return (by - ay) * 12 + (bm - am);
  };
  let paidMarked = 0, cleared = 0;
  for (const r of rows) {
    const { data: los } = await supabase.from('orders').select('id, order_key').like('order_key', `LT_${r.room_final}_%`);
    const all = (los ?? []).sort((a: any, b: any) => (a.order_key.split('_').pop() < b.order_key.split('_').pop() ? -1 : 1));
    if (all.length) { await supabase.from('orders').update({ paid: false, paid_at: null }).in('id', all.map((o: any) => o.id)); cleared += all.length; }
    if (!r.first_payment_date || !r.paid_through) continue;
    const step = STEP_OF[r.cadence] || 1;
    const k = Math.max(0, Math.round(monthsBetween(r.first_payment_date, r.paid_through) / step));
    const toPay = all.slice(0, (k + 1) * step).map((o: any) => o.id);
    if (toPay.length) { await supabase.from('orders').update({ paid: true, paid_at: r.first_payment_date }).in('id', toPay); paidMarked += toPay.length; }
  }

  return NextResponse.json({ contracts: inserted, newProperties: newProps, sourceUpdated: srcUpdated, clearedPaidMarks: cleared, paidMonthsMarked: paidMarked });
}
