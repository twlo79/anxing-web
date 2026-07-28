import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import seed from '@/data/zl_contracts.json';
import { onlyLtOf } from '@/lib/ltKey';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!process.env.IMPORT_KEY || req.headers.get('x-import-key') !== process.env.IMPORT_KEY)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'no service key' }, { status: 500 });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);

  const { data: est } = await supabase.from('estates').select('id').eq('name', '正隆').single();
  if (!est) return NextResponse.json({ error: '找不到正隆 estate' }, { status: 400 });
  const zl = est.id;
  const rows = seed as any[];

  // 1) 建缺少的房源
  const { data: props } = await supabase.from('properties').select('name').eq('estate_id', zl);
  const have = new Set((props ?? []).map((p: any) => p.name));
  const newProps = Array.from(new Set(rows.map((r) => r.room))).filter((r) => !have.has(r)).map((name) => ({ name, estate_id: zl }));
  if (newProps.length) await supabase.from('properties').insert(newProps);

  // 2) 清舊正隆契約再灌
  await supabase.from('contracts').delete().eq('estate_id', zl);
  const contracts = rows.map((r) => {
    const incomplete = !r.start || !r.end || !r.monthly_rent;
    return {
      estate_id: zl, room: r.room, tenant_name: r.tenant, phone: null,
      cadence: r.cadence, monthly_rent: r.monthly_rent || 0, amount_per_period: r.amount_per_period || 0, deposit: r.deposit || 0,
      start_date: r.start || '2026-01-01', end_date: r.end || '2026-12-31', first_payment_date: r.first_payment_date || null, pay_day: null,
      account: null, note: incomplete ? '⚠待補租期' : null, active: !incomplete,
      name: `${r.tenant ?? ''}-${r.room}`,
    };
  });
  let inserted = 0;
  for (let i = 0; i < contracts.length; i += 20) {
    const { error } = await supabase.from('contracts').insert(contracts.slice(i, i + 20));
    if (error) return NextResponse.json({ error: error.message, inserted }, { status: 500 });
    inserted += Math.min(20, contracts.length - i);
  }

  // 3) 先清空正隆長租已收記號,再依「已收至」以「期」標記已收(paid_at 一律用第一次收租日)
  const monthsBetween = (a: string, b: string) => {
    const [ay, am] = a.slice(0, 7).split('-').map(Number);
    const [by, bm] = b.slice(0, 7).split('-').map(Number);
    return (by - ay) * 12 + (bm - am);
  };
  const STEP_OF: Record<string, number> = { monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 };
  let paidMarked = 0, cleared = 0;
  for (const r of rows) {
    const { data: los } = await supabase.from('orders').select('id, order_key').like('order_key', `LT_${r.room}_%`);
    const all = onlyLtOf(los as any[], r.room).sort((a: any, b: any) => (a.order_key.split('_').pop() < b.order_key.split('_').pop() ? -1 : 1));
    if (all.length) { await supabase.from('orders').update({ paid: false, paid_at: null }).in('id', all.map((o: any) => o.id)); cleared += all.length; }
    if (!r.first_payment_date || !r.paid_through) continue;
    const step = STEP_OF[r.cadence] || 1;
    // floor 而非 round:繳到第 N 期就只認 N 期。用 round 會在季繳/半年繳/年繳時
    // 多認一整期(例:年繳繳滿 12 個月 → round(11/12)=1 → 誤標 24 個月已收)
    const k = Math.max(0, Math.floor(monthsBetween(r.first_payment_date, r.paid_through) / step)); // 已繳到第 k 期(0-based)
    const toPay = all.slice(0, (k + 1) * step).map((o: any) => o.id);                              // 前 (k+1) 期的月份
    if (toPay.length) { await supabase.from('orders').update({ paid: true, paid_at: r.first_payment_date }).in('id', toPay); paidMarked += toPay.length; }
  }

  const incomplete = rows.filter((r) => !r.start || !r.end || !r.monthly_rent).map((r) => r.room);
  return NextResponse.json({ contracts: inserted, newProperties: newProps.length, clearedPaidMarks: cleared, paidMonthsMarked: paidMarked, incomplete });
}
