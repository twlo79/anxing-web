/*
 * 一次性回填：把 Airbnb 全部評價的「細節評分／標籤／私訊留言／listingId／官方中文翻譯」
 * 補進安幸 ERP。列表端點沒有這些欄位，要另外打詳情端點（每則一次）。
 *
 * ── 怎麼跑 ────────────────────────────────────────────────
 * 1. Chrome 開 https://www.airbnb.com/performance/quality/overall/reviews 並確認已登入
 * 2. F12 → Console
 * 3. 整份貼上、Enter
 * 4. 讓那個分頁**保持在前景**（切走會被 Chrome 凍結，速度掉到爬）
 *
 * 約 861 則、10~15 分鐘。中途關掉沒關係：進度存在 localStorage，
 * 重貼一次會從斷點接著跑。要重頭來過就先執行 localStorage.removeItem('anxing_backfill')
 *
 * ── 為什麼不是 Claude 直接跑 ──────────────────────────────
 * Claude 透過 CDP 執行 JS 時，分頁在背景會被凍結，一次 navigate 只塞得下 3 個請求
 * （12 個就逾時，2026-09-03 實測）。861 則要 ~290 次來回，不划算。
 * 在前景 Console 裡跑就沒有這個限制。
 *
 * ── 安全性 ────────────────────────────────────────────────
 * 只做 upsert，不刪任何東西。ERP 端點保證：不覆蓋已翻成中文的留言、
 * 不把既有的房源對應洗成 null。重跑同一批是安全的。
 */

(async () => {
  const IMPORT_KEY = 'anxing-import-7f3k9m2qx8w4';
  const ERP = 'https://justwork.estia.com.tw';
  const API_KEY = 'd306zoyjsyarp7ifhu67rjxn52tv0t20';
  const USER_ID = 'VXNlcjoyOTg5MTA0NTg=';           // 本帳號固定值
  const LIST_HASH = '015be4eeaa5e444fa22bc0bf82688aa0f21028c3836b2e442c537a904c9d5e14';
  const DETAIL_HASH = '9b32dd76b3eb7502b5eb35037b57d12b264e18011ad62edb2423b86e520dee19';
  const PAGE = 10;          // ⚠️ 不要改成 50 —— limit=50 現在會永遠 pending
  const POST_CHUNK = 10;
  const GAP = 150;          // 每個詳情請求之間的間隔(ms)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('%c[backfill]', 'color:#0a7', ...a);

  // ── 進度（可續跑）──────────────────────────────────────
  const KEY = 'anxing_backfill';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = (s) => localStorage.setItem(KEY, JSON.stringify(s));
  const state = load();
  state.done = state.done || [];             // 已成功送出的 review id
  const doneSet = new Set(state.done);

  // ── Airbnb：評價列表 ───────────────────────────────────
  async function rv(offset, limit) {
    const vars = { request: {
      clientName: 'web-performance-dash-reviews-search',
      arguments: { metricType: 'QUALITY', groupBys: ['RATING_CATEGORY'], groupByValues: ['overall'] },
      componentArguments: [{ componentName: 'RECENT_REVIEWS_SECTION', arguments: { offset, limit } }],
      useStubbedData: false } };
    const ext = { persistedQuery: { version: 1, sha256Hash: LIST_HASH } };
    // locale 必須是 zh-TW：用 en 會拿到英文房源名，跟 DB 的中文原名對不上
    const u = `https://www.airbnb.com/api/v3/ReviewsSectionQuery/${LIST_HASH}`
      + '?operationName=ReviewsSectionQuery&locale=zh-TW&currency=TWD'
      + '&variables=' + encodeURIComponent(JSON.stringify(vars))
      + '&extensions=' + encodeURIComponent(JSON.stringify(ext));
    const r = await fetch(u, { headers: { 'X-Airbnb-Api-Key': API_KEY }, credentials: 'include' });
    return (await r.json()).data.porygon.getPerformanceComponents.components[0];
  }

  // ── Airbnb：單則評價詳情 ───────────────────────────────
  async function detail(id) {
    const vars = { reviewId: btoa('StayListingReview:' + id), userId: USER_ID };
    const ext = { persistedQuery: { version: 1, sha256Hash: DETAIL_HASH } };
    const u = `https://www.airbnb.com/api/v3/HostReviewsSingleReviewRefreshedDesignQuery/${DETAIL_HASH}`
      + '?operationName=HostReviewsSingleReviewRefreshedDesignQuery&locale=zh-TW&currency=TWD'
      + '&variables=' + encodeURIComponent(JSON.stringify(vars))
      + '&extensions=' + encodeURIComponent(JSON.stringify(ext));
    const r = await fetch(u, { headers: { 'X-Airbnb-Api-Key': API_KEY }, credentials: 'include' });
    const j = await r.json();
    return j?.data?.presentation?.hostReviews?.ratingStatsAndReview ?? null;
  }

  // base64 的 "StaySupplyListing:947419509809418322" → "947419509809418322"
  function listingIdOf(d) {
    const raw = d?.review?.staySupplyListing?.id;
    if (!raw) return null;
    try { const s = atob(raw); const i = s.indexOf(':'); return i < 0 ? null : s.slice(i + 1); }
    catch { return null; }
  }

  // 詳情 → 要送給 ERP 的欄位。抓不到就整組不送（缺欄位比錯欄位好救）
  function extra(d) {
    if (!d || !d.review) return {};
    const rev = d.review;
    const o = {};
    const lid = listingIdOf(d);
    if (lid) o.listingId = lid;
    if (rev.reservation?.numberOfNights != null) o.nights = rev.reservation.numberOfNights;
    if (rev.commentLanguage) o.lang = rev.commentLanguage;
    if (rev.localizedComment?.localizedString) o.localized = rev.localizedComment.localizedString;
    if (rev.privateFeedback) o.privateFb = rev.privateFeedback;
    if (rev.localizedPrivateFeedback?.localizedString) o.privateFbLoc = rev.localizedPrivateFeedback.localizedString;
    if (rev.response) o.reply = typeof rev.response === 'string' ? rev.response : (rev.response.comment ?? null);

    const cats = {}, tags = {};
    for (const c of d.categoryStatsWithTagStats || []) {
      if (!c.category) continue;
      if (c.categoryRating?.value != null) cats[c.category] = c.categoryRating.value;
      const ts = (c.tagCountsMap || []).filter((t) => t.label)
        .map((t) => ({ label: t.label, intent: t.intent, ...(t.comment ? { comment: t.comment } : {}) }));
      if (ts.length) tags[c.category] = ts;
    }
    if (Object.keys(cats).length) o.cats = cats;
    if (Object.keys(tags).length) o.tags = tags;
    return o;
  }

  async function post(path, body) {
    const r = await fetch(ERP + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-import-key': IMPORT_KEY },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }

  // ── 1. 抓全部評價列表 ──────────────────────────────────
  log('開始抓評價列表…');
  const rows = [], seen = new Set();
  let total = null;
  for (let off = 0; ; off += PAGE) {
    let c = null;
    for (let a = 0; a < 3 && !c; a++) {
      try { c = await rv(off, PAGE); } catch { await sleep(800); }
    }
    if (!c) { console.error('[backfill] 列表第 ' + off + ' 頁連續失敗，中止'); return; }
    total = c.totalCount;
    for (const r of c.reviews) {
      const id = String(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id, guest: r.title, stay: r.subtitle,
        rating: Number(r.metricUnits?.[0]?.valueString),
        comment: r.comment, listing: r.listingName,
      });
    }
    if (off % 100 === 0) log(`列表 ${rows.length}/${total}`);
    if (c.reviews.length < PAGE) break;
    await sleep(GAP);
  }
  log(`列表完成：${rows.length} 筆（Airbnb totalCount = ${total}）`);

  const todo = rows.filter((r) => !doneSet.has(r.id));
  log(`待處理 ${todo.length} 筆（已完成 ${doneSet.size} 筆，續跑）`);

  // ── 2. 逐筆抓詳情 → 分批送 ERP ─────────────────────────
  const failedDetail = [];
  let buf = [], sent = 0, inserted = 0, updated = 0, byOrder = 0;
  const unmatchedAll = {}, unresolvedAll = new Set();

  async function flush() {
    if (!buf.length) return;
    const { status, json } = await post('/api/import/reviews', { reviews: buf });
    if (status !== 200) { console.error('[backfill] 匯入失敗', status, json); throw new Error('import failed'); }
    inserted += json.inserted || 0;
    updated += json.updated || 0;
    byOrder += json.resolvedByOrder || 0;
    for (const [k, v] of Object.entries(json.unmatched || {})) unmatchedAll[k] = (unmatchedAll[k] || 0) + v;
    for (const n of json.unresolved || []) unresolvedAll.add(n);
    for (const r of buf) { doneSet.add(r.id); state.done.push(r.id); }
    save(state);
    sent += buf.length;
    buf = [];
    log(`已送出 ${sent}/${todo.length}（新增 ${inserted}、更新 ${updated}）`);
  }

  for (const r of todo) {
    let d = null;
    for (let a = 0; a < 2 && !d; a++) {
      try { d = await detail(r.id); } catch { await sleep(500); }
    }
    if (!d) failedDetail.push(r.id);
    buf.push({ ...r, ...extra(d) });
    if (buf.length >= POST_CHUNK) await flush();
    await sleep(GAP);
  }
  await flush();

  // ── 3. 結果 ───────────────────────────────────────────
  log('──────── 完成 ────────');
  log(`送出 ${sent} 筆：新增 ${inserted}、更新 ${updated}`);
  log(`靠訂單反查補房源 ${byOrder} 筆（應該接近 0；偏高代表 listingId 沒對上）`);
  if (failedDetail.length) console.warn('[backfill] 詳情抓不到（細節評分會是空的）：', failedDetail);
  if (Object.keys(unmatchedAll).length) console.warn('[backfill] listing_id 對不到房源：', unmatchedAll);
  if (unresolvedAll.size) console.warn('[backfill] 房源名稱查不到：', [...unresolvedAll]);
  log('進度已存 localStorage。要重頭跑：localStorage.removeItem("anxing_backfill")');
})();
