import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TYPE_SRC: Record<string, string> = { longterm: 'longterm', company: 'company', office: 'office' };
const AHEAD = 1; // 產生到「本月 + 1」

const ymNum = (d: Date) => d.getFullYear() * 100 + (d.getMonth() + 1);
const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate(); // m: 1-12

export async function POST(req: Request) {
  if (!process.env.IMPORT_KEY || req.headers.get('x-import-key') !== process.env.IMPORT_KEY)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'no service key' }, { status: 500 });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);

  const now = new Date();
  const horizon = new Date(now.getFullYear(), now.getMonth() + AHEAD, 1);
  const horizonYm = ymNum(horizon);

  const { data: cons, error: ce } = await supabase.from('contracts')
    .select('id, estate_id, room, tenant_name, type, monthly_rent, start_date, end_date')
    .eq('active', true).eq('auto_renew', true);
  if (ce) return NextResponse.json({ error: ce.message }, { status: 500 });

  let inserted = 0; const perContract: any[] = [];
  for (const c of cons ?? []) {
    if (!c.start_date || !c.monthly_rent) continue;
    const src = TYPE_SRC[c.type as string] || 'longterm';
    // 目標月份: start ~ horizon
    const sd = new Date((c.start_date as string) + 'T00:00:00');
    let cur = new Date(sd.getFullYear(), sd.getMonth(), 1);
    const targets: { ym: string; y: number; m: number }[] = [];
    let g = 0;
    while (ymNum(cur) <= horizonYm && g++ < 480) {
      targets.push({ ym: `${cur.getFullYear()}${String(cur.getMonth() + 1).padStart(2, '0')}`, y: cur.getFullYear(), m: cur.getMonth() + 1 });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    // 既有月份
    const { data: ex } = await supabase.from('orders').select('order_key').eq('contract_id', c.id).like('order_key', 'LT_%');
    const have = new Set((ex ?? []).map((o: any) => o.order_key));
    const toAdd = targets
      .filter((t) => !have.has(`LT_${c.room}_${t.ym}`))
      .map((t) => {
        const dim = daysInMonth(t.y, t.m);
        const co = new Date(t.y, t.m, 1); // 次月1日
        return {
          order_key: `LT_${c.room}_${t.ym}`, source: src, contract_id: c.id, estate_id: c.estate_id,
          property_raw: c.room, guest_name: c.tenant_name,
          checkin: `${t.y}-${String(t.m).padStart(2, '0')}-01`,
          checkout: `${co.getFullYear()}-${String(co.getMonth() + 1).padStart(2, '0')}-01`,
          nights: dim, amount: c.monthly_rent, paid: false, imported_via: 'auto-renew',
        };
      });
    for (let i = 0; i < toAdd.length; i += 50) {
      const { error } = await supabase.from('orders').insert(toAdd.slice(i, i + 50));
      if (error) return NextResponse.json({ error: error.message, inserted }, { status: 500 });
    }
    if (toAdd.length) { inserted += toAdd.length; perContract.push({ room: c.room, tenant: c.tenant_name, added: toAdd.length }); }
  }

  return NextResponse.json({ horizon: horizonYm, autoRenewContracts: (cons ?? []).length, monthsAdded: inserted, perContract });
}
