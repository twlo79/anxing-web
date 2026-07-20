import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import snapshots from '@/data/snapshots.json';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!process.env.IMPORT_KEY || req.headers.get('x-import-key') !== process.env.IMPORT_KEY)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'no service key' }, { status: 500 });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);

  // 冪等:全刪重建
  const { error: de } = await supabase.from('revenue_snapshots').delete().gte('created_at', '2000-01-01');
  if (de) return NextResponse.json({ error: 'delete: ' + de.message }, { status: 500 });

  const SRC_MAP: Record<string, string> = { partner: 'airbnb', airbnb_cancelled: 'oneoff' };
  const rows = (snapshots as any[]).map((r) => ({ ...r, source: SRC_MAP[r.source] ?? r.source }));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('revenue_snapshots').insert(rows.slice(i, i + 500));
    if (error) return NextResponse.json({ error: error.message, inserted }, { status: 500 });
    inserted += Math.min(500, rows.length - i);
  }
  const byYm: Record<string, number> = {};
  rows.forEach((r) => { byYm[r.ym] = (byYm[r.ym] || 0) + r.month_amount; });
  return NextResponse.json({ inserted, months: Object.fromEntries(Object.entries(byYm).map(([k, v]) => [k, Math.round(v as number)])) });
}
