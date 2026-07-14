import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': 'https://www.airbnb.com',
  'Access-Control-Allow-Headers': 'content-type, x-import-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

const MONTHS: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

// "Jul 6 – 10, 2026" / "Jun 10 – Jul 8, 2026" / "Dec 28, 2025 – Jan 2, 2026"
function parseStay(s: string): [string | null, string | null] {
  try {
    const [L, R] = s.split('–').map((x) => x.trim());
    const rYear = (R.match(/(\d{4})/) || [])[1];
    const lYear = (L.match(/(\d{4})/) || [])[1];
    const lM = (L.match(/[A-Z][a-z]{2}/) || [])[0] as string;
    const rM = (R.match(/[A-Z][a-z]{2}/) || [])[0];
    const lD = (L.match(/\b(\d{1,2})\b/) || [])[1] as string;
    const rD = (R.match(/\b(\d{1,2})\b/) || [])[1] as string;
    if (!rYear || !lM || !lD || !rD) return [null, null];
    let ci = new Date(Date.UTC(+((lYear || rYear) as string), MONTHS[lM] - 1, +lD));
    const co = new Date(Date.UTC(+rYear, MONTHS[(rM || lM) as string] - 1, +rD));
    if (ci > co) ci = new Date(Date.UTC(+((lYear || rYear) as string) - 1, MONTHS[lM] - 1, +lD));
    const f = (d: Date) => d.toISOString().slice(0, 10);
    return [f(ci), f(co)];
  } catch {
    return [null, null];
  }
}

function cleanTags(tags: any) {
  if (!tags) return null;
  const out: Record<string, { label: string; intent: string; comment?: string }[]> = {};
  for (const [cat, arr] of Object.entries(tags as Record<string, any[]>)) {
    out[cat] = (arr || []).map((t: any) => {
      const o: any = { label: t.label, intent: t.intent };
      if (t.comment) o.comment = t.comment;
      return o;
    });
  }
  return out;
}

export async function POST(req: Request) {
  if (!process.env.IMPORT_KEY || req.headers.get('x-import-key') !== process.env.IMPORT_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
  }
  if (!process.env.SUPABASE_SERVICE_KEY) {
    return NextResponse.json({ error: 'SUPABASE_SERVICE_KEY not configured' }, { status: 500, headers: CORS });
  }
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);

  const body = await req.json();
  const items: any[] = body.reviews ?? [];
  if (!items.length) return NextResponse.json({ upserted: 0 }, { headers: CORS });

  const { data: props, error: pe } = await supabase.from('properties').select('id, airbnb_listing_id');
  if (pe) return NextResponse.json({ error: pe.message }, { status: 500, headers: CORS });
  const propByListing = Object.fromEntries((props ?? []).filter((p) => p.airbnb_listing_id).map((p) => [p.airbnb_listing_id, p.id]));

  const unmatched: Record<string, number> = {};
  const records = items.map((m) => {
    const [ci, co] = parseStay(m.stay || '');
    const propertyId = m.listingId ? propByListing[m.listingId] ?? null : null;
    if (m.listingId && !propertyId) unmatched[m.listingId] = (unmatched[m.listingId] || 0) + 1;
    const dc: any = {};
    if (m.privateFb) dc.private_feedback = m.privateFb;
    if (m.privateFbLoc) dc.private_feedback_localized = m.privateFbLoc;
    const tags = cleanTags(m.tags);
    if (tags) dc.tags = tags;
    const c = m.cats || {};
    return {
      airbnb_review_id: String(m.id),
      property_id: propertyId,
      listing_name_raw: m.listing || m.listEN || null,
      guest_name: m.guest || '(unknown)',
      checkin_date: ci,
      checkout_date: co,
      nights: m.nights ?? null,
      overall_rating: m.rating,
      comment: m.localized || m.comment || null,
      comment_original: m.comment || null,
      comment_language: m.lang || null,
      rating_checkin: c.CHECKIN ?? null,
      rating_cleanliness: c.CLEANLINESS ?? null,
      rating_accuracy: c.ACCURACY ?? null,
      rating_communication: c.COMMUNICATION ?? null,
      rating_location: c.LOCATION ?? null,
      rating_value: c.VALUE ?? null,
      detail_comments: Object.keys(dc).length ? dc : null,
      host_reply: m.reply || null,
      source_url: 'https://www.airbnb.com/performance/quality/overall/reviews/review/' + m.id,
      imported_via: 'auto',
    };
  }).filter((r) => r.overall_rating != null);

  let upserted = 0;
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    const { error } = await supabase.from('reviews').upsert(batch, { onConflict: 'airbnb_review_id' });
    if (error) return NextResponse.json({ error: error.message, upserted }, { status: 500, headers: CORS });
    upserted += batch.length;
  }
  return NextResponse.json({ upserted, unmatched }, { headers: CORS });
}
