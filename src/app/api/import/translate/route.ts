import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': 'https://www.airbnb.com',
  'Access-Control-Allow-Headers': 'content-type, x-import-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

const hasCJK = (t: string | null | undefined) => !!t && /[一-鿿]/.test(t);
const auth = (req: Request) => !!process.env.IMPORT_KEY && req.headers.get('x-import-key') === process.env.IMPORT_KEY;
const db = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

// GET:列出「留言尚未翻成中文」的評價(comment 內無中文字)。備援用,一般排程直接用匯入回傳的 needTranslation 即可。
export async function GET(req: Request) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
  if (!process.env.SUPABASE_SERVICE_KEY) return NextResponse.json({ error: 'no service key' }, { status: 500, headers: CORS });
  const supabase = db();
  const limit = Math.min(parseInt(new URL(req.url).searchParams.get('limit') || '80', 10) || 80, 300);
  const rows: any[] = [];
  for (let from = 0; from < 5000; from += 1000) {
    const { data, error } = await supabase.from('reviews').select('airbnb_review_id, comment, comment_original').order('id', { ascending: true }).range(from, from + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS });
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const pending = rows
    .filter((r) => r.comment && r.comment.trim() && !hasCJK(r.comment))
    .map((r) => ({ rid: r.airbnb_review_id, src: hasCJK(r.comment_original) ? r.comment : (r.comment_original || r.comment) }))
    .slice(0, limit);
  return NextResponse.json({ pending, count: pending.length }, { headers: CORS });
}

// POST:寫回翻譯後的中文留言。body: { items: [{ rid, comment }] } (rid = airbnb_review_id)
export async function POST(req: Request) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
  if (!process.env.SUPABASE_SERVICE_KEY) return NextResponse.json({ error: 'no service key' }, { status: 500, headers: CORS });
  const supabase = db();
  const items: any[] = (await req.json()).items ?? [];
  let updated = 0;
  const failed: string[] = [];
  for (const it of items) {
    const rid = it?.rid ?? it?.id;
    // 僅接受含中文的翻譯,避免誤寫回英文
    if (!rid || !it?.comment || !hasCJK(it.comment)) { if (rid) failed.push(String(rid)); continue; }
    const { error } = await supabase.from('reviews').update({ comment: it.comment, comment_language: 'zh-TW' }).eq('airbnb_review_id', String(rid));
    if (error) failed.push(String(rid)); else updated++;
  }
  return NextResponse.json({ updated, failed: failed.length }, { headers: CORS });
}
