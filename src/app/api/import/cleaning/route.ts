import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { fetchIn } from '@/lib/fetch-all';
import { notifyImport } from '@/lib/push';
import { importTitle, importBody } from '@/lib/notify-text';

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-import-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function normUnit(s: string) {
  return (s || '').toUpperCase()
    .replace(/開封|時兆|正隆|亞曼尼|台視|JPR|NEW|舊|整層|（[^）]*）|\([^)]*\)|房|樓|層|棟|\s/g, '')
    .replace(/A0*(\d)/g, 'A$1').replace(/B0*(\d)/g, 'B$1');
}
function parseRating(note: string | null, given: any): number | null {
  if (given != null && given !== '') { const n = parseInt(String(given), 10); if (n >= 1 && n <= 5) return n; }
  const m = String(note || '').match(/([1-5])\s*星/);
  return m ? parseInt(m[1], 10) : null;
}

export async function POST(req: Request) {
  if (!process.env.IMPORT_KEY || req.headers.get('x-import-key') !== process.env.IMPORT_KEY)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'SUPABASE_SERVICE_KEY not configured' }, { status: 500, headers: CORS });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);
  const body = await req.json();
  const items: any[] = body.records ?? [];
  if (!items.length) return NextResponse.json({ inserted: 0, updated: 0 }, { headers: CORS });

  const { data: staff } = await supabase.from('staff').select('id, name, aliases, staff_type');
  const staffByName: Record<string, any> = {};
  for (const s of staff ?? []) {
    staffByName[s.name] = s;
    for (const a of s.aliases ?? []) staffByName[a] = s;
  }
  const { data: props } = await supabase.from('properties').select('id, name, estate_id, estates(name)');
  const propList = (props ?? []).map((p: any) => ({ id: p.id, name: p.name, estate: p.estates?.name }));

  const unmatchedProp: Record<string, number> = {};
  const records = items.map((r) => {
    const s = staffByName[String(r.staff_name || '').trim()] || null;
    let propertyId: string | null = null;
    const rawUnit = normUnit(r.property_raw || '');
    const cand = propList.filter((p) => p.estate === r.estate_name);
    let hit = cand.find((p) => normUnit(p.name) === rawUnit);
    if (!hit && rawUnit) hit = cand.find((p) => normUnit(p.name).includes(rawUnit) || rawUnit.includes(normUnit(p.name)));
    if (hit) propertyId = hit.id;
    else if (r.property_raw) unmatchedProp[`${r.estate_name}/${r.property_raw}`] = (unmatchedProp[`${r.estate_name}/${r.property_raw}`] || 0) + 1;

    return {
      record_key: String(r.record_key),
      record_date: r.record_date,
      staff_name: String(r.staff_name || '').trim(),
      staff_id: s?.id ?? null,
      staff_type: s?.staff_type ?? 'other',
      property_id: propertyId,
      property_raw: r.property_raw || null,
      estate_name: r.estate_name || null,
      overall_rating: parseRating(r.note, r.overall_rating),
      note: r.note || null,
      doc_url: r.doc_url || null,
      source: r.source || 'make',
    };
  });

  // 同上：撈不全 inserted 會虛報。upsert 不會產生重複資料，錯的只有回報數字。
  const keys = records.map((r) => r.record_key);
  const { rows: existing } = await fetchIn<{ record_key: string }>(
    keys,
    (chunk, f, t) => supabase.from('cleaning_records').select('record_key').in('record_key', chunk).range(f, t));
  const has = new Set(existing.map((e) => e.record_key));
  const inserted = keys.filter((k) => !has.has(k)).length;

  for (let i = 0; i < records.length; i += 500) {
    const { error } = await supabase.from('cleaning_records').upsert(records.slice(i, i + 500), { onConflict: 'record_key' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS });
  }

  /*
   * 【清潔記錄的通知原本掛在錯的端點上】（2026-08-16）
   *
   * `notifyImport('cleaning', …)` 之前掛在 `/api/import/housekeeping`
   * ——那是 TimeTree 排班匯入，寫的是 `hk_event`，不是清潔記錄。
   *
   * 結果是:「清潔記錄通知」那個開關實際上通知的是排班匯入，
   * 而真的新增清潔記錄時一個字都不會發。
   * 訊息內容還寫「新增 N 筆排班記錄」—— 文字跟開關名稱對不起來，
   * 但沒有人會把兩邊放在一起看。
   *
   * 【只有真的新增才通知】
   * 這支是 upsert,每天同步都會跑。筆數沒變只是內容更新的話不叮 ——
   * 一天一則、內容永遠一樣的通知，很快就會被整個關掉。
   */
  if (inserted > 0) {
    const fresh = records.filter((r) => !has.has(r.record_key));
    const lines = fresh.slice(0, 6).map((r) =>
      [r.record_date, r.property_raw || r.estate_name || '(未對應房源)', r.staff_name]
        .filter(Boolean).join('・'));
    await notifyImport('cleaning', importTitle(inserted, '筆', '清潔記錄'),
      importBody(lines), '/cleaning');
  }

  return NextResponse.json({ inserted, updated: records.length - inserted, total: records.length, unmatchedProp }, { headers: CORS });
}
