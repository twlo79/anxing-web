import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { parseRows, staffLookup, splitAssignees, type HkStaff, type HkProperty } from '@/lib/hkParse';

/**
 * 房務排班匯入。
 *
 * 給排程爬蟲呼叫：爬到的原始事件丟進來，這裡負責解析與寫入。
 * 解析邏輯跟前端共用 src/lib/hkParse.ts —— 兩邊各寫一份遲早會分岔，
 * 到時候「畫面上預覽的結果」跟「排程實際寫進去的」就不一樣了。
 *
 * POST /api/import/housekeeping
 *   headers: x-import-key
 *   body: {
 *     period?: "202607",          // 省略則由第一筆的日期推得
 *     dryRun?: true,              // 只回報解析結果，不寫入（預設 false）
 *     records: [{ date, title, assignees }]   // assignees 可為字串或陣列
 *   }
 *
 * 同月份是全刪重建。解析規則會演進，增量更新會讓新舊規則的結果
 * 混在同一個月裡，對不出來是哪一版算的。
 */

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-import-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  if (!process.env.IMPORT_KEY || req.headers.get('x-import-key') !== process.env.IMPORT_KEY)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'SUPABASE_SERVICE_KEY not configured' }, { status: 500, headers: CORS });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY);
  const body = await req.json();
  const records: any[] = body.records ?? [];
  const dryRun = body.dryRun === true;
  if (!records.length) return NextResponse.json({ error: 'no records' }, { status: 400, headers: CORS });

  const rows = records.map((r) => ({
    date: String(r.date ?? '').slice(0, 10),
    title: String(r.title ?? '').trim(),
    assignees: Array.isArray(r.assignees) ? r.assignees.join(' + ') : String(r.assignees ?? ''),
  })).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.title);

  if (!rows.length)
    return NextResponse.json({ error: 'no valid rows（date 需為 YYYY-MM-DD 且 title 不可空白）' }, { status: 400, headers: CORS });

  const period: string = body.period ?? rows[0].date.slice(0, 7).replace('-', '');

  const [{ data: staffRows }, { data: propRows }] = await Promise.all([
    supabase.from('hk_staff').select('*').eq('active', true).order('sort'),
    supabase.from('hk_property').select('*').eq('active', true).order('sort'),
  ]);
  const staff = (staffRows ?? []) as HkStaff[];
  const props = (propRows ?? []) as HkProperty[];
  if (!staff.length)
    return NextResponse.json({ error: 'hk_staff 是空的，請先執行 migration_58' }, { status: 500, headers: CORS });

  // include_gift 是設定,不是常數 —— 端點與畫面必須讀同一份,
  // 否則排程匯入的結果會跟人工匯入不一樣。
  const { data: settingRows } = await supabase.from('hk_setting').select('key, value');
  const settings = Object.fromEntries((settingRows ?? []).map((x: any) => [x.key, x.value]));
  const includeGift = settings['include_gift'] !== 'false';

  const parsed = parseRows(rows, staff, props, { includeGift });
  const byName = staffLookup(staff);

  // 排程跑完要能一眼看出有沒有問題，所以這幾個數字一定要回傳
  const report = {
    period,
    total: parsed.length,
    counted: 0,
    leave: 0,
    noAssignee: [] as string[],
    unknownProperty: [] as string[],
    unknownStaff: [] as string[],
    skipped: 0,
  };
  for (const r of rows) {
    // 用 splitAssignees 而不是自己再切一次 —— 分隔符的規則只該有一個地方定義
    for (const n of splitAssignees(r.assignees)) {
      if (!byName.has(n) && !report.unknownStaff.includes(n)) report.unknownStaff.push(n);
    }
  }
  for (const e of parsed) {
    if (e.excluded === 'leave') report.leave++;
    else if (e.excluded === 'no_assignee') report.noAssignee.push(`${e.date} ${e.title}`);
    else if (e.excluded) report.skipped++;
    else {
      report.counted++;
      if (e.unknownToken && !report.unknownProperty.includes(e.unknownToken))
        report.unknownProperty.push(e.unknownToken);
    }
  }

  if (dryRun) return NextResponse.json({ dryRun: true, ...report }, { headers: CORS });

  // ── 寫入 ────────────────────────────────────────────
  await supabase.from('hk_work_item').delete().eq('period', period);
  await supabase.from('hk_event').delete().eq('period', period);

  const events = parsed.map((e) => ({
    period, event_date: e.date, title: e.title, assignees: e.assigneeNames,
    parsed_code: e.propertyCode, work_type: e.workType, excluded: e.excluded,
  }));
  const { data: inserted, error: ee } = await supabase.from('hk_event')
    .insert(events).select('id, event_date, title');
  if (ee) return NextResponse.json({ error: ee.message }, { status: 500, headers: CORS });

  // 事件 id 對回解析結果。日期+標題可能重複（同日兩筆同名），
  // 所以用「同鍵的第幾筆」配對，不能只靠鍵本身。
  const seen = new Map<string, number>();
  const idOf = new Map<string, string>();
  for (const row of inserted ?? []) {
    const k = `${row.event_date}|${row.title}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    idOf.set(`${k}|${n}`, row.id);
  }
  const seen2 = new Map<string, number>();

  const workItems: any[] = [];
  const dayRows: any[] = [];
  for (const e of parsed) {
    const k = `${e.date}|${e.title}`;
    const n = seen2.get(k) ?? 0;
    seen2.set(k, n + 1);
    const eventId = idOf.get(`${k}|${n}`);
    if (!eventId) continue;

    if (e.excluded === 'leave') {
      const s = staff.find((x) => x.code === e.leaveStaffCode);
      if (s) dayRows.push({
        period, work_date: e.date, staff_id: s.id,
        status: e.title.includes('颱風') ? '颱風假' : '休',
      });
      continue;
    }
    if (e.excluded) continue;

    for (const name of e.assigneeNames) {
      const s = byName.get(name);
      if (!s || s.count_mode === 'none') continue;   // 入住準備組不展開成工作項
      workItems.push({
        event_id: eventId, period, work_date: e.date,
        property_code: e.propertyCode, work_type: e.workType, staff_id: s.id,
      });
    }
  }

  if (workItems.length) {
    const { error } = await supabase.from('hk_work_item').insert(workItems);
    if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS });
  }
  if (dayRows.length) {
    // 休假只寫狀態，不覆蓋已經手動填過的時數
    const { error } = await supabase.from('hk_day')
      .upsert(dayRows, { onConflict: 'work_date,staff_id', ignoreDuplicates: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS });
  }

  return NextResponse.json({
    ...report,
    workItems: workItems.length,
    leaveDays: dayRows.length,
  }, { headers: CORS });
}
