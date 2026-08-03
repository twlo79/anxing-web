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

const fmtDate = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

// 中文(繁/簡)住宿日期: "2026年5月25日至7月21日" / "2026年7月15日至20日" / "2025年12月28日至2026年1月2日"
// 右側的「年」「月」可省略,會沿用左側
function parseStayZh(s: string): [string | null, string | null] {
  const m = s.match(
    /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(?:至|到|~|–|—|-|\u2013|\u2014)\s*(?:(\d{4})\s*年\s*)?(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日/
  );
  if (!m) return [null, null];
  const lY = +m[1], lM = +m[2], lD = +m[3];
  const rY = m[4] ? +m[4] : lY;
  const rM = m[5] ? +m[5] : lM;
  const rD = +m[6];
  return [fmtDate(lY, lM, lD), fmtDate(rY, rM, rD)];
}

// "Jul 6 – 10, 2026" / "Jun 10 – Jul 8, 2026" / "Dec 28, 2025 – Jan 2, 2026"
function parseStayEn(s: string): [string | null, string | null] {
  try {
    const [L, R] = s.split(/[\u2013\u2014–—-]/).map((x) => x.trim());
    if (!R) return [null, null];
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

// 同時支援中文(airbnb.com.tw)與英文(airbnb.com)住宿日期格式
function parseStay(s: string): [string | null, string | null] {
  if (!s) return [null, null];
  if (/[年月日]/.test(s)) return parseStayZh(s);
  return parseStayEn(s);
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

  // 先解析住宿日期 —— 下面要用「房客 + 退房日」去訂單裡查房源
  const parsed = items.map((m) => {
    const [ci, co] = parseStay(m.stay || '');
    return { m, ci, co, rid: String(m.id) };
  });

  /**
   * 第二層備援:用訂單反查房源。
   *
   * 原本這層是「房源名稱 → property_id」的自學對照,但實測發現不可行:
   * 開封 2F/3F/4F/整棟 在 Airbnb 用了完全相同的標題,全站有 23 個名稱
   * 被多間房源共用。名稱在結構上就分不出是哪一間,猜了必錯,
   * 而且自學機制會把第一次的錯誤固化下來、往後一路套用。
   *
   * 訂單則是另一條管道進來的事實資料(Airbnb 訂單匯入,以 code 對應),
   * 記錄了房客實際住哪一間。用「房客 + 退房日」接回去,實測 17/17 全中。
   *
   * 一樣只採計唯一解:同名房客在同一天退房於不同單位就跳過,不猜。
   */
  const orderProp: Record<string, string> = {};
  {
    const checkouts = Array.from(new Set(parsed.map((p) => p.co).filter(Boolean))) as string[];
    const seen: Record<string, Set<string>> = {};
    for (let i = 0; i < checkouts.length; i += 200) {
      const { data } = await supabase.from('orders')
        .select('guest_name, checkout, property_id')
        .in('checkout', checkouts.slice(i, i + 200))
        .not('property_id', 'is', null);
      for (const o of data ?? []) {
        if (!o.guest_name) continue;
        const k = `${o.guest_name}|${o.checkout}`;
        (seen[k] ||= new Set()).add(String(o.property_id));
      }
    }
    for (const k of Object.keys(seen)) {
      if (seen[k].size === 1) orderProp[k] = Array.from(seen[k])[0];
    }
  }

  // 既有評價的 property_id:用來避免「這次解析不出房源」時把原本正確的值蓋成 null
  const prevProp = new Map<string, string | null>();

  // 已存在的評價:保留已翻譯成中文的 comment,重新匯入時不覆蓋(只補日期等欄位)
  const incomingIds = items.map((m) => String(m.id));
  const { data: prevRows } = await supabase.from('reviews').select('airbnb_review_id, comment, property_id').in('airbnb_review_id', incomingIds);
  const prevComment = new Map((prevRows ?? []).map((r) => [r.airbnb_review_id, r.comment as string | null]));
  (prevRows ?? []).forEach((r) => prevProp.set(r.airbnb_review_id, (r.property_id as string | null) ?? null));
  const hasCJK = (t: string | null | undefined) => !!t && /[\u4e00-\u9fff]/.test(t);

  const unmatched: Record<string, number> = {};
  const guessedByOrder: string[] = [];
  const records = parsed.map(({ m, ci, co, rid }) => {
    // 三層解析:listing_id → 訂單反查 → 保留既有值。
    // 最後一層是關鍵 —— 解析不出來時絕不能寫 null,那會把先前正確的對應洗掉。
    const byListing = m.listingId ? propByListing[m.listingId] ?? null : null;
    const byOrder = (!byListing && co && m.guest) ? orderProp[`${m.guest}|${co}`] ?? null : null;
    if (byOrder) guessedByOrder.push(rid);
    const propertyId = byListing ?? byOrder ?? (prevProp.get(rid) ?? null);
    if (m.listingId && !propByListing[m.listingId]) unmatched[m.listingId] = (unmatched[m.listingId] || 0) + 1;
    const dc: any = {};
    if (m.privateFb) dc.private_feedback = m.privateFb;
    if (m.privateFbLoc) dc.private_feedback_localized = m.privateFbLoc;
    const tags = cleanTags(m.tags);
    if (tags) dc.tags = tags;
    const c = m.cats || {};
    return {
      airbnb_review_id: rid,
      property_id: propertyId,
      listing_name_raw: m.listing || m.listEN || null,
      guest_name: m.guest || '(unknown)',
      checkin_date: ci,
      checkout_date: co,
      nights: m.nights ?? null,
      overall_rating: m.rating,
      comment: hasCJK(prevComment.get(String(m.id))) ? prevComment.get(String(m.id)) : (m.localized || m.comment || null),
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

  // 先查哪些 id 已存在,回報時區分「新增」與「更新」
  const ids = records.map((r) => r.airbnb_review_id);
  const { data: existing } = await supabase.from('reviews').select('airbnb_review_id').in('airbnb_review_id', ids);
  const existingSet = new Set((existing ?? []).map((e) => e.airbnb_review_id));
  const inserted = ids.filter((id) => !existingSet.has(id)).length;

  let upserted = 0;
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    const { error } = await supabase.from('reviews').upsert(batch, { onConflict: 'airbnb_review_id' });
    if (error) return NextResponse.json({ error: error.message, upserted }, { status: 500, headers: CORS });
    upserted += batch.length;
  }

  // 這批匯入後,留言仍非中文(需要翻譯)的清單:rid=airbnb_review_id, src=待翻原文
  const needTranslation = records
    .filter((r) => r.comment && !hasCJK(r.comment))
    .map((r) => ({ rid: r.airbnb_review_id, src: r.comment_original || r.comment }));

  // 三層都解析不出房源的,列出來讓呼叫端知道(否則會靜默留 null)
  const unresolved = Array.from(new Set(
    records.filter((r) => !r.property_id).map((r) => r.listing_name_raw || '(無房源名稱)')
  ));

  // resolvedByOrder:這幾筆的 listingId 缺漏,是靠訂單反查補上的。
  // 數字持續偏高就表示抓取端沒帶 listingId,那才是根治的地方 ——
  // 訂單反查只是備援,不該變成主要來源。
  return NextResponse.json({
    upserted, inserted, updated: upserted - inserted,
    unmatched, unresolved, resolvedByOrder: guessedByOrder.length, needTranslation,
  }, { headers: CORS });
}
