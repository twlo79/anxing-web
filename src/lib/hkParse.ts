/**
 * 排班事件解析。
 *
 * 從「日期,事項,負責人」三欄的原始紀錄，解析出：
 *   - 房源代碼（對照 hk_property 的 code 與 aliases）
 *   - 工作類型
 *   - 負責人（可多人，用 + 分隔）
 *   - 是否要排除（休假、無指派、非統計人員）
 *
 * 刻意放在前端而不是資料庫：匯入時要能即時預覽解析結果，
 * 讓人在寫入前就看到哪幾筆會被排除、哪幾個房源沒認出來。
 */

export type HkStaff = {
  id: string; source_name: string; code: string; name: string;
  /** 排班表上可能出現的顯示名,可多個 —— 同一個人的顯示名會隨時間改 */
  source_names?: string[];
  count_mode: 'rooms' | 'hours' | 'none';
  count_cleans: boolean;
  color: string | null; color_text?: string | null; color_bar?: string | null;
  leave_prefix: string | null;
};

/** 一個人可能對應多個顯示名,全部展開成 名稱 → 人員 的查表 */
export function staffLookup(staff: HkStaff[]) {
  const m = new Map<string, HkStaff>();
  for (const s of staff) {
    const names = (s.source_names?.length ? s.source_names : [s.source_name]).filter(Boolean);
    for (const n of names) m.set(n, s);
  }
  return m;
}

export type HkProperty = {
  code: string; aliases: string[]; beds: number | null;
  linen_group: 'kai' | 'ab' | 'zl' | 'other'; is_common: boolean;
};

export type RawRow = { date: string; title: string; assignees: string };

export type ParsedEvent = {
  date: string;
  title: string;
  assigneeNames: string[];
  propertyCode: string | null;
  /** 標題裡抽出來但對不到主檔的字串,進例外清單 */
  unknownToken: string | null;
  workType: string;
  /** 排除原因。null = 採計 */
  excluded: 'leave' | 'no_assignee' | 'not_counted' | null;
  leaveStaffCode: string | null;
};

const WORK_TYPES: [RegExp, string][] = [
  [/^退[-\s]?/, '退房清潔'],
  [/贈/, '贈品補充'],
  [/入住清潔/, '入住清潔'],
  [/換房清潔/, '換房清潔'],
  [/細清/, '細清'],
  [/點交/, '點交'],
  [/拆備品/, '拆備品'],
];

/** 沒有房源可言的工作 */
const NO_PROPERTY = ['協助行政', '洗烘折毛巾', '聚餐', '開會', '教育訓練'];

/**
 * 從標題抽出「可能是房源」的候選字串。
 *
 * 純 regex 撐不住這些寫法:
 *   退-A2-Martin Kossa（7/31退…）   退17B5-劉珈予(8/4)
 *   贈-4B1*2                        A5-贈
 *   14B1入住清潔                    時兆公區-34樓洗衣間地板
 *   繼續4B1完成
 *
 * 所以改成:先把雜訊剝掉,再拿剩下的頭幾段去對主檔別名。
 */
function candidates(title: string): string[] {
  const out: string[] = [];
  // 括號內是備註,先拿掉 —— 裡面常有日期與其他房號,會誤判
  let t = title.replace(/[（(][^）)]*[）)]/g, ' ');
  // 動作字樣不是房源的一部分
  t = t.replace(/^退[-\s]?/, ' ')
       .replace(/^贈[-\s]?/, ' ')
       .replace(/^繼續/, ' ')
       .replace(/(入住清潔|換房清潔|入住準備|細清|點交|拆備品|清潔|入住|完成|要鋪床|贈)/g, ' ')
       .replace(/[*＊]\s*\d+/g, ' ')     // 贈-4B1*2 的數量
       .replace(/\s+私\s*$/, ' ');

  // 用分隔符切開,前面幾段才可能是房源(後面通常是房客名或說明)
  const parts = t.split(/[-—–、,，/\s]+/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts.slice(0, 3)) {
    out.push(p);
    // 「時兆公區2」「時兆二樓公區」這種黏在一起的,把尾巴的數字剝掉再試一次
    const stripped = p.replace(/\d+$/, '');
    if (stripped && stripped !== p) out.push(stripped);
  }
  // 整串也當一個候選 —— 「開2-1」被上面切成 開2 / 1 會對錯
  out.unshift(t.trim());
  return out.filter(Boolean);
}

/** 建立「別名 → code」的查表,長的別名優先比對 */
export function buildLookup(props: HkProperty[]) {
  const map = new Map<string, string>();
  for (const p of props) {
    map.set(p.code, p.code);
    for (const a of p.aliases ?? []) map.set(a, p.code);
  }
  // 長的優先:「開封整棟」要在「開封」之前命中
  const keys = Array.from(map.keys()).sort((a, b) => b.length - a.length);
  return { map, keys };
}

export function matchProperty(title: string, lk: ReturnType<typeof buildLookup>) {
  if (NO_PROPERTY.some((k) => title.includes(k))) return { code: null, unknown: null };

  const cands = candidates(title);

  // 先做「長的優先」的包含比對,再做切段後的完全比對。順序不能顛倒 ——
  // 「退-開2-1-Ho Yin」切段會得到 ['開2','1','Ho'],完全比對會命中「開2」,
  // 但正確答案是「開2-1」。包含比對按長度排序就會先試到 4 個字的「開2-1」。
  //
  // 同理「A18-Marlee」會先命中 A18 而不是 A1,「台1+2」先於「台1」。
  for (const k of lk.keys) {
    // 單字母代碼(M / V / C)不做包含比對 —— 「Michael」裡有 M,會亂命中。
    // 那幾個只靠下面的切段完全比對。
    if (k.length < 2) continue;
    if (title.includes(k)) return { code: lk.map.get(k)!, unknown: null };
  }

  for (const c of cands) {
    const hit = lk.map.get(c);
    if (hit) return { code: hit, unknown: null };
  }
  return { code: null, unknown: cands[1] ?? cands[0] ?? title };
}

/**
 * 打掃次數。
 *
 *   Σ_日期 MAX_over_人( 該人當日在該房源的工作項數 )
 *
 * 為什麼是 MAX 而不是 COUNT,也不是「同日算一次」:
 *   兩人合掃同一間  → 各 1 筆,MAX = 1  ✓ 布巾只換一次
 *   同日兩筆不同事件 → 某人 2 筆,MAX = 2 ✓ 真的清了兩次
 *
 * 用 COUNT 會讓合掃翻倍;用「同日去重」則會把同日的兩次清掃併成一次。
 * 兩種都會讓床單估算失準,而且方向相反。
 */
export function cleanCounts(
  items: { work_date: string; property_code: string | null; staff_id: string }[],
  mode: 'clean' | 'headcount' = 'clean',
): Record<string, number> {
  const out: Record<string, number> = {};
  if (mode === 'headcount') {
    for (const i of items) {
      if (i.property_code) out[i.property_code] = (out[i.property_code] ?? 0) + 1;
    }
    return out;
  }
  // date|code → staff_id → 該人當日在該房源的筆數
  const grid = new Map<string, Map<string, number>>();
  for (const i of items) {
    if (!i.property_code) continue;
    const k = `${i.work_date}|${i.property_code}`;
    if (!grid.has(k)) grid.set(k, new Map());
    const m = grid.get(k)!;
    m.set(i.staff_id, (m.get(i.staff_id) ?? 0) + 1);
  }
  for (const [k, m] of grid) {
    const code = k.split('|')[1];
    out[code] = (out[code] ?? 0) + Math.max(...m.values());
  }
  return out;
}

function workTypeOf(title: string) {
  for (const [re, t] of WORK_TYPES) if (re.test(title)) return t;
  return '清潔';
}

/** 「SHAO-YING HSIEH + Ayu」→ ['SHAO-YING HSIEH', 'Ayu'] */
export function splitAssignees(s: string): string[] {
  const t = (s ?? '').trim();
  if (!t || t === '(未指派)' || t === '未指派') return [];
  return t.split(/[+＋]/).map((x) => x.trim()).filter(Boolean);
}

export function parseRows(
  rows: RawRow[], staff: HkStaff[], props: HkProperty[],
  opts: { includeGift?: boolean } = {},
): ParsedEvent[] {
  const lk = buildLookup(props);
  const byName = staffLookup(staff);
  const leaveMap = staff.filter((s) => s.leave_prefix)
    .map((s) => [s.leave_prefix!, s.code] as const);

  return rows.map((r) => {
    const title = (r.title ?? '').trim();
    const names = splitAssignees(r.assignees);

    // 休假:標題以 U休 / A休 開頭。「A休-颱風假」「U休-補（7/10）颱風假」都算。
    const leave = leaveMap.find(([prefix]) => title.startsWith(prefix));
    if (leave) {
      return {
        date: r.date, title, assigneeNames: names,
        propertyCode: null, unknownToken: null, workType: '休假',
        excluded: 'leave', leaveStaffCode: leave[1],
      };
    }

    if (!names.length) {
      return {
        date: r.date, title, assigneeNames: [],
        propertyCode: null, unknownToken: null, workType: workTypeOf(title),
        excluded: 'no_assignee', leaveStaffCode: null,
      };
    }

    // 全部負責人都不計工作量 → 整筆不採計
    const counted = names.filter((n) => {
      const s = byName.get(n);
      return s && s.count_mode !== 'none';
    });

    const workType = workTypeOf(title);
    if (opts.includeGift === false && workType === '贈品補充') {
      return {
        date: r.date, title, assigneeNames: names,
        propertyCode: null, unknownToken: null, workType,
        excluded: 'not_counted', leaveStaffCode: null,
      };
    }

    const { code, unknown } = matchProperty(title, lk);
    return {
      date: r.date, title, assigneeNames: names,
      propertyCode: code, unknownToken: unknown, workType,
      excluded: counted.length ? null : 'not_counted', leaveStaffCode: null,
    };
  });
}
