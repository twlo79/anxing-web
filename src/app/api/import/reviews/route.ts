import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { notifyImport } from '@/lib/push';
import { reviewLine, importBody, importTitle } from '@/lib/notify-text';
// Supabase 一次只回 1000 列且不報錯 —— 「哪些已存在」查不全會覆蓋既有翻譯
import { fetchIn } from '@/lib/fetch-all';

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

  const { data: props, error: pe } = await supabase.from('properties').select('id, name');
  if (pe) return NextResponse.json({ error: pe.message }, { status: 500, headers: CORS });
  /*
   * listing_id → 房源走 listing_property_map（migration_127）——
   * 一間房在 Airbnb 上被重建過就會換一個新編號，而
   * properties.airbnb_listing_id 只放得下一個。
   * 讀那個欄位的話，舊編號的評價會對不到房源。
   */
  const { data: maps } = await supabase.from('listing_property_map')
    .select('listing_id, property_id');
  const propByListing = Object.fromEntries((maps ?? []).map((m) => [m.listing_id, m.property_id]));
  // 通知要顯示房源名稱。用我們自己的名字，不用 Airbnb 的標題 ——
  // 「開封 2F/3F/4F」在 Airbnb 是同一個標題，看了也分不出是哪一間
  const nameById = Object.fromEntries((props ?? []).map((p) => [p.id, p.name]));

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
    {
      /*
       * 這裡比對的是 checkout 日期,**一天可能有幾十筆訂單** ——
       * 200 個日期輕易就回超過 1000 列而被截掉。
       * 截掉的後果是那幾則評價對不到房源,落進「未對應」——
       * 看起來像爬蟲沒給 listingId（既有的已知問題），
       * 實際上是資料撈不全，兩者症狀一模一樣、非常難分辨。
       */
      const { rows: data } = await fetchIn<{ guest_name: string | null; checkout: string; property_id: string }>(
        checkouts,
        (chunk, f, t) => supabase.from('orders')
          .select('guest_name, checkout, property_id')
          .in('checkout', chunk).not('property_id', 'is', null).range(f, t),
        200);
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

  /*
   * 已存在的評價:保留已翻譯成中文的 comment,重新匯入時不覆蓋(只補日期等欄位)。
   *
   * ⚠️ **這個查詢撈不全會造成永久性的資料損失。**
   * Supabase 一次只回 1000 列且不報錯 —— 全量同步送進來兩千則評價時，
   * 後一千則查不到既有紀錄，就會被當成「沒有翻譯過」而用英文原文覆蓋。
   * 翻譯是花錢叫 API 做的，蓋掉就沒了，而且不會有任何錯誤訊息。
   */
  const incomingIds = items.map((m) => String(m.id));
  const { rows: prevRows } = await fetchIn<{ airbnb_review_id: string; comment: string | null; property_id: string | null }>(
    incomingIds,
    (chunk, f, t) => supabase.from('reviews')
      .select('airbnb_review_id, comment, property_id').in('airbnb_review_id', chunk).range(f, t));
  const prevComment = new Map(prevRows.map((r) => [r.airbnb_review_id, r.comment as string | null]));
  prevRows.forEach((r) => prevProp.set(r.airbnb_review_id, (r.property_id as string | null) ?? null));
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

  /*
   * 先查哪些 id 已存在,回報時區分「新增」與「更新」。
   * 撈不全的話「新增」會虛報 —— 而這個數字現在會被拿去發推播通知
   * （「爬蟲同步新增 N 則評價」），虛報就等於每天叮一則假的。
   */
  const ids = records.map((r) => r.airbnb_review_id);
  const { rows: existing } = await fetchIn<{ airbnb_review_id: string }>(
    ids,
    (chunk, f, t) => supabase.from('reviews')
      .select('airbnb_review_id').in('airbnb_review_id', chunk).range(f, t));
  const existingSet = new Set(existing.map((e) => e.airbnb_review_id));
  const newRecords = records.filter((r) => !existingSet.has(r.airbnb_review_id));
  const inserted = newRecords.length;

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
  /*
   * 只有「真的新增」才通知。
   *
   * 這支是 upsert:每次同步都會把既有評價寫一次（翻譯補上、房東回覆更新…）,
   * 所以 upserted 幾乎每天都是幾百筆,而 inserted 才是新評價。
   * 用 upserted 發通知等於每天叮一次「有 300 則新評價」—— 那會直接被關掉。
   */
  if (inserted > 0) {
    /*
     * 星等放最前面 —— 5 星不用處理，3 星要。
     * 星等就是「這則通知要不要點開」的答案，它必須被保證看得到。
     */
    const lines = newRecords.map((r) => reviewLine({
      rating: r.overall_rating,
      property: (r.property_id ? nameById[r.property_id] : null) ?? r.listing_name_raw,
      guest: r.guest_name,
    }));
    await notifyImport('reviews', importTitle(inserted, '則', '評價'),
      importBody(lines), '/reviews');
  }

  /*
   * 同步紀錄。跟訂單那支同一個機制：差異清單整批換成這一輪的結果，
   * 修好對照表之後那一列隔天自己消失。
   *
   * 評價這邊的「差異」只有一種：對不到房源。用 listing_id 當鍵 ——
   * 同一個 listing 通常一次對不到好幾則，而要修的只有對照表那一個地方。
   */
  const issues = [
    ...Object.entries(unmatched).map(([listingId, n]) => ({
      code: listingId, field: '對不到房源', listingId,
      to: `${n} 則評價沒有房源`,
      // 沒有房源就沒有物業，沒有物業就查不到那天是誰在管 ——
      // 這幾則評價會一直落在管家評分的「未指派」那一列
      severity: 'high',
      reason: '這個 listing 在系統裡沒有對照，評價找不到房源。'
        + '沒有房源就沒有物業，管家評分會把它算進「未指派」。到「房源管理」補上對照',
    })),
    // 有 listing_id 但三層都解析不出來的,列名稱 —— 那通常是共用標題
    ...unresolved.map((name) => ({
      code: name, field: '房源名稱查不到',
      to: '三層備援都對不到,可能是多間房源共用同一個 Airbnb 標題',
      severity: 'mid',
      reason: '通常是多間房源在 Airbnb 用了同一個標題（開封 2F/3F/4F 就是這樣）。'
        + '要靠訂單反查，或在「房源管理」手動指定 listing_id',
    })),
  ];
  const { error: logErr } = await supabase.rpc('record_sync_run', {
    p_kind: 'reviews',
    p_counts: {
      received: items.length, inserted, updated: upserted - inserted,
      detail: {
        對不到房源: Object.keys(unmatched).length,
        房源名稱查不到: unresolved.length,
        靠訂單反查補上: guessedByOrder.length,
        待翻譯: needTranslation.length,
      },
    },
    p_issues: issues,
  });
  if (logErr) console.error('[sync] 同步紀錄寫入失敗（匯入本身不受影響）:', logErr.message);

  return NextResponse.json({
    upserted, inserted, updated: upserted - inserted,
    unmatched, unresolved, resolvedByOrder: guessedByOrder.length, needTranslation,
  }, { headers: CORS });
}
