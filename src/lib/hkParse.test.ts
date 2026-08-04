import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRows, cleanCounts, filterItems, splitAssignees, buildLookup, matchProperty, staffLookup,
  type HkStaff, type HkProperty, type HkWorkType,
} from './hkParse.ts';
import { ROWS_202607, STAFF, PROPS } from './__fixtures__/hk-202607.ts';

/**
 * 排班解析器的測試。
 *
 * 跑法：npm test
 *
 * 這支是整個房務模組的守門員。解析規則改動時，先看這裡有沒有紅 ——
 * 開發期間有兩個 bug 就是靠底下的期望值抓到的：
 *   1. 打掃次數用「同日去重」而非 MAX_over_人，同日兩筆不同事件被併成一次
 *   2. 「開2-1」被分隔符切成「開2」，對到錯誤的房源
 * 兩個都不會讓程式當掉，只會讓數字悄悄變小。
 */

const staff = STAFF as unknown as HkStaff[];
const props = PROPS as unknown as HkProperty[];
const lk = buildLookup(props);
const match = (title: string) => matchProperty(title, lk).code;

describe('房源解析', () => {
  test('退房清潔的各種寫法', () => {
    assert.equal(match('退-A2-Martin Kossa'), 'A2');
    assert.equal(match('退17B5-劉珈予(8/4)'), '17B5');
    assert.equal(match('退-開封整棟-James'), '開整棟');       // 別名
  });

  test('較長的代碼優先，短的不能先命中', () => {
    // 「開2-1」曾被切成「開2」。分隔符切段的完全比對會贏過正確答案，
    // 所以包含比對必須按長度排序且先跑。
    assert.equal(match('退-開2-1-Ho Yin（角落牆壁冷氣都要清潔）'), '開2-1');
    assert.equal(match('開2-Seng Hong-入住'), '開2');
    assert.equal(match('退-A18-Marlee Gaitanis'), 'A18');     // 不是 A1
    assert.equal(match('退-A15-Kevin Loo 私'), 'A15');
    assert.equal(match('贈-台1+2'), '台1+2');                  // 不是 台1
    assert.equal(match('退-台1+2-Tiger Wang'), '台1+2');
  });

  test('贈品的兩種寫法', () => {
    assert.equal(match('贈-4B1*2'), '4B1');
    assert.equal(match('A5-贈'), 'A5');
    assert.equal(match('贈-4B5（第一次）'), '4B5');
    assert.equal(match('贈-14B1*1'), '14B1');
  });

  test('房源與動作黏在一起', () => {
    assert.equal(match('14B1入住清潔'), '14B1');
    assert.equal(match('台2換房清潔'), '台2');
    assert.equal(match('18B2細清'), null);                     // 主檔沒有 18B2
    assert.equal(match('繼續4B1完成'), '4B1');
    assert.equal(match('9A5-要鋪床'), '9A5');
  });

  test('公區', () => {
    assert.equal(match('時兆公區-34樓洗衣間地板'), '時兆公區');
    assert.equal(match('時兆公區2、3、4樓'), '時兆公區');
    assert.equal(match('時兆二樓公區（包含廁所/流理台/地板/辦公室）'), '時兆二樓');
    assert.equal(match('開封樓梯公共區域櫃子'), '開封公區');   // 別名
  });

  test('括號裡的日期不能被當成房源', () => {
    assert.equal(match('退-台S-凱威(7/11退）'), '台S');
    assert.equal(match('退-A7-侯子（6/30退、7/2油漆、7/6矽利康）'), 'A7');
    assert.equal(match('退-B4-Emir Habul 私（7/27）'), 'B4');
  });

  test('沒有房源的工作', () => {
    assert.equal(match('協助行政'), null);
    assert.equal(match('洗烘折毛巾'), null);
  });

  test('單字母代碼不做包含比對', () => {
    // 主檔有 M / V / C。若做包含比對，「Michael」「Carol」都會誤命中。
    assert.equal(match('退-J2-Michael'), 'J2');
  });
});

describe('負責人', () => {
  test('多人用 + 分隔', () => {
    assert.deepEqual(splitAssignees('SHAO-YING HSIEH + Ayu'), ['SHAO-YING HSIEH', 'Ayu']);
    assert.deepEqual(splitAssignees('花花 + 劉姐'), ['花花', '劉姐']);
    assert.deepEqual(splitAssignees('Ayu'), ['Ayu']);
  });

  test('未指派視為沒有負責人', () => {
    assert.deepEqual(splitAssignees('(未指派)'), []);
    assert.deepEqual(splitAssignees(''), []);
  });

  test('一個人可以有多個顯示名', () => {
    const lookup = staffLookup([
      { ...staff[0], source_names: ['SHAO-YING HSIEH', 'Una'] },
    ] as HkStaff[]);
    assert.equal(lookup.get('SHAO-YING HSIEH')?.code, 'UNA');
    assert.equal(lookup.get('Una')?.code, 'UNA');
  });
});

describe('休假', () => {
  test('前綴對應到人', () => {
    const [a] = parseRows([{ date: '2026-07-03', title: 'A休', assignees: 'Ayu' }], staff, props);
    assert.equal(a.excluded, 'leave');
    assert.equal(a.leaveStaffCode, '庭玉');
  });

  test('帶後綴的休假一樣算', () => {
    const rows = [
      { date: '2026-07-10', title: 'A休-颱風假', assignees: 'Ayu' },
      { date: '2026-07-12', title: 'U休-補（7/10）颱風假', assignees: 'SHAO-YING HSIEH' },
    ];
    const out = parseRows(rows, staff, props);
    assert.equal(out[0].excluded, 'leave');
    assert.equal(out[1].excluded, 'leave');
    assert.equal(out[1].leaveStaffCode, 'UNA');
  });
});

describe('打掃次數', () => {
  const D = '2026-07-07';
  test('兩人合掃同一間只算一次', () => {
    const items = [
      { work_date: D, property_code: '14B2', staff_id: 'una' },
      { work_date: D, property_code: '14B2', staff_id: 'ayu' },
    ];
    assert.equal(cleanCounts(items)['14B2'], 1);
  });

  test('同日兩筆不同事件算兩次', () => {
    // 這正是 7/7 時兆公區的情況：二三四樓地板 + 34樓洗衣間地板，兩人各做兩筆
    const items = [
      { work_date: D, property_code: '時兆公區', staff_id: 'una' },
      { work_date: D, property_code: '時兆公區', staff_id: 'una' },
      { work_date: D, property_code: '時兆公區', staff_id: 'ayu' },
      { work_date: D, property_code: '時兆公區', staff_id: 'ayu' },
    ];
    assert.equal(cleanCounts(items)['時兆公區'], 2);
  });

  test('headcount 模式用人頭計次', () => {
    const items = [
      { work_date: D, property_code: '14B2', staff_id: 'una' },
      { work_date: D, property_code: '14B2', staff_id: 'ayu' },
    ];
    assert.equal(cleanCounts(items, 'headcount')['14B2'], 2);
  });

  test('沒有房源的工作不計次', () => {
    assert.deepEqual(cleanCounts([{ work_date: D, property_code: null, staff_id: 'una' }]), {});
  });
});

/** migration_59 的 hk_work_type 種子 */
const WORK_TYPES: HkWorkType[] = [
  { code: '退房清潔', count_workload: true, count_linen: true },
  { code: '入住清潔', count_workload: true, count_linen: true },
  { code: '換房清潔', count_workload: true, count_linen: true },
  { code: '細清', count_workload: true, count_linen: true },
  { code: '公區清潔', count_workload: true, count_linen: true },
  { code: '贈品補充', count_workload: true, count_linen: true },
  { code: '點交', count_workload: true, count_linen: false },
  { code: '拆備品', count_workload: true, count_linen: false },
  { code: '清潔', count_workload: true, count_linen: true },
  { code: '其他工時', count_workload: true, count_linen: false },
];

describe('設定過濾（filterItems）', () => {
  const mk = (work_type: string, property_code: string | null = 'A1') =>
    ({ work_date: '2026-07-01', property_code, staff_id: 'una', work_type });

  test('主檔沒登記的工作類型視為兩個都開', () => {
    // 漏建檔不該讓資料靜靜消失 —— 那種錯不會報錯，只會讓月底數字變小
    const r = filterItems([mk('沒見過的類型')], { workTypes: WORK_TYPES });
    assert.equal(r.rooms.length, 1);
    assert.equal(r.linen.length, 1);
  });

  test('計布巾關掉的類型:算間數但不算床單', () => {
    const r = filterItems([mk('拆備品'), mk('點交')], { workTypes: WORK_TYPES });
    assert.equal(r.rooms.length, 2);
    assert.equal(r.linen.length, 0);
  });

  test('房源自己關掉計布巾也會被擋', () => {
    const r = filterItems([mk('退房清潔', '復興')], {
      workTypes: WORK_TYPES,
      properties: [{ code: '復興', count_linen: false }],
    });
    assert.equal(r.rooms.length, 1);
    assert.equal(r.linen.length, 0);
  });

  test('include_gift 關掉時,贈品補充兩邊都不算', () => {
    const r = filterItems([mk('贈品補充'), mk('退房清潔')],
      { workTypes: WORK_TYPES, includeGift: false });
    assert.equal(r.rooms.length, 1);
    assert.equal(r.linen.length, 1);
  });

  test('公區清潔要計布巾 —— 解析器不會產生這個類型,', () => {
    // 公區事件被解析成「清潔」。若這裡設成不計布巾，
    // 匯入的算、手動改成「公區清潔」的不算，同一件事因來源而異。
    // 公區的 beds=0，床數本來就是 0，不需要靠這個開關擋。
    const r = filterItems([mk('公區清潔', '時兆公區')], { workTypes: WORK_TYPES });
    assert.equal(r.linen.length, 1, '公區清潔不該被排除，否則會跟解析出的「清潔」結果不一致');
  });
});

describe('2026-07 全月（對照人工 Excel）', () => {
  const parsed = parseRows(ROWS_202607, staff, props, { includeGift: true });
  const byName = staffLookup(staff);

  const rooms: Record<string, number> = {};
  const leaves: Record<string, number> = {};
  const items: { work_date: string; property_code: string | null; staff_id: string }[] = [];
  const itemsWithType: { work_date: string; property_code: string | null; staff_id: string; work_type: string }[] = [];
  const unknown = new Set<string>();
  let noAssignee = 0;

  for (const e of parsed) {
    if (e.excluded === 'leave') { leaves[e.leaveStaffCode!] = (leaves[e.leaveStaffCode!] ?? 0) + 1; continue; }
    if (e.excluded === 'no_assignee') { noAssignee++; continue; }
    if (e.unknownToken) unknown.add(e.unknownToken);
    for (const n of e.assigneeNames) {
      const s = byName.get(n);
      if (!s) continue;
      if (s.count_mode === 'rooms') rooms[s.code] = (rooms[s.code] ?? 0) + 1;
      if (s.count_cleans && e.propertyCode) {
        items.push({ work_date: e.date, property_code: e.propertyCode, staff_id: s.id });
        itemsWithType.push({ work_date: e.date, property_code: e.propertyCode, staff_id: s.id, work_type: e.workType });
      }
    }
  }
  const counts = cleanCounts(items);

  test('事件總數', () => assert.equal(parsed.length, 139));

  test('間數與人工表相符', () => {
    assert.equal(rooms['UNA'], 42);
    assert.equal(rooms['庭玉'], 42);
  });

  test('休假天數', () => {
    assert.equal(leaves['UNA'], 9);
    assert.equal(leaves['庭玉'], 11);
  });

  test('未指派的事件不計入統計', () => assert.equal(noAssignee, 3));

  test('沒有未識別的房源', () => {
    assert.deepEqual([...unknown], [],
      `未識別：${[...unknown].join('、')} —— 主檔缺代碼或別名`);
  });

  test('打掃次數與人工表相符', () => {
    assert.equal(counts['時兆公區'], 8);
    assert.equal(counts['4B1'], 3);
    assert.equal(counts['4B5'], 3);
    assert.equal(counts['開2-1'], 2);   // 曾被誤判成「開2」
    assert.equal(counts['開整棟'], 2);
    assert.equal(counts['台1+2'], 2);
  });

  test('套用工作類型設定後,只有 9A5 的次數會變', () => {
    // 7/4「9A5拆備品」的拆備品不計布巾，所以 9A5 從 2 變 1。
    // 其餘數字必須完全不動 —— 這是接上設定時最容易誤傷的地方。
    const { linen } = filterItems(itemsWithType, { workTypes: WORK_TYPES, properties: props });
    const after = cleanCounts(linen);
    assert.equal(after['9A5'], 1, '拆備品不計布巾');
    assert.equal(after['時兆公區'], 8);
    assert.equal(after['4B1'], 3);
    assert.equal(after['4B5'], 3);
    assert.equal(after['復興'], 2);
  });

  test('劉姐不計間數，但她掃的房間要計次', () => {
    assert.equal(rooms['LIU'], undefined);
    // 復興 7/23、7/30 兩次都是劉姐 —— 不算的話床單會少領
    assert.equal(counts['復興'], 2);
    assert.equal(counts['9A5'], 2);
  });

  test('入住準備組完全不產生工作項', () => {
    const prep = parsed.filter((e) => !e.excluded
      && e.assigneeNames.every((n) => byName.get(n)?.count_mode === 'none'));
    assert.equal(prep.length, 0, '入住準備組的事件應該被標記為 not_counted');
  });
});
