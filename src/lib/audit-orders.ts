/**
 * 驗算模式：一次把訂單資料掃過，找出「看起來不對」的地方。
 *
 * ============================================================
 * 【為什麼要有這個】
 *
 * 這個專案已經吃過三次同一種虧，而三次都不是系統壞掉：
 *
 *   2026-07  同一筆訂單因為房客改名變成兩列，當月營收多算 33,053
 *   2026-08  29 組重複訂單，多算 782,102
 *   2026-08  A15 同一段期間被兩筆訂單佔用，重疊 32 天
 *
 * 三次都是資料本身有問題，而報表照樣算得出一個漂亮的數字。
 * **錯誤的資料不會報錯**，它只會安靜地變成營收。
 *
 * 所以需要一個「懷疑一切」的模式：不改資料、不擋操作，
 * 只把可疑的地方標出來讓人自己判斷。
 *
 *
 * ============================================================
 * 【為什麼是開關，不是常駐】
 *
 * 常駐的話這些標記會變成背景雜訊 —— 每天看到、每天忽略，
 * 幾週之後就跟沒有一樣。而且有些「異常」是合理的（長住優惠、
 * 整棟出租），常駐標記會逼人去解釋一堆本來就沒問題的資料。
 *
 * 做成按下去才看的話，它是一個「我現在要對帳」的動作。
 */

export type AuditIssue = '重複訂單' | '房源過載' | '資料缺失' | '房價過低' | '日期不合理';

export type AuditOrder = {
  id: string;
  source: string | null;
  property_raw: string | null;
  estate_id: string | null;
  guest_name: string | null;
  checkin: string | null;
  checkout: string | null;
  nights: number | null;
  amount: number | null;
  /** 加費子單。跟母單同房同日期，不是重複也不佔用天數 */
  parent_order_id?: string | null;
  /** 移房拆出來的段落。同一筆訂單被切成好幾段，不是重複 */
  move_group?: string | null;
};

/** 每晚單價低於同房源均價的幾成算低（使用者指定：6 成）。 */
export const AUDIT_LOW_RATIO = 0.6;
/** 均價至少要幾筆才算數。一兩筆算出來的「均價」只是那一兩筆本身。 */
export const AUDIT_MIN_SAMPLE = 3;

/** 一次性收入的來源 —— 這些沒有住宿天數，不參與佔用與均價 */
const ONEOFF = new Set(['oneoff', 'airbnb_cancelled']);

/**
 * 已作廢的訂單。
 *
 * 【為什麼整筆跳過所有檢查】
 * 爬蟲把 Airbnb 取消單作廢時，就是把金額設成 0、來源改成 airbnb_cancelled。
 * 那個 0 是**正確的狀態**，不是漏填。
 *
 * 不跳過的話，三百多筆取消單會全部被標成「資料缺失」——
 * 而標記一旦大量出現在正常資料上，真正該看的那幾筆就被淹掉了。
 * 那時候這個功能就等於沒有。
 *
 * 作廢的單不進營收、不佔房間、也沒有任何要修的地方，所以完全不看。
 */
const isVoided = (o: AuditOrder) => String(o.source ?? '') === 'airbnb_cancelled';

const DAY = 86400000;
const t = (d: string) => new Date(`${d}T00:00:00Z`).getTime();
/** 兩個日期相差幾天 */
export const daysBetween = (a: string, b: string) => Math.round((t(b) - t(a)) / DAY);
const addDays = (d: string, n: number) =>
  new Date(t(d) + n * DAY).toISOString().slice(0, 10);

/** 這一筆算不算「住宿」—— 一次性收入、取消單、加費子單都不算 */
export function isStay(o: AuditOrder): boolean {
  if (ONEOFF.has(String(o.source ?? ''))) return false;
  if (o.parent_order_id) return false;
  return !!(o.checkin && o.checkout);
}

/**
 * 這筆訂單在 [from, to]（含頭含尾）這段期間裡佔用了幾晚。
 *
 * 住宿佔用的是 checkin 到 checkout 的**前一晚**：
 * 10/1 入住、10/3 退房 = 佔用 10/1 與 10/2 兩晚，10/3 那天房間是空的。
 * 算成三天的話，連續兩筆訂單（前一筆 10/3 退、後一筆 10/3 進）
 * 會被誤判成重疊。
 */
export function nightsInRange(
  o: AuditOrder, from?: string, to?: string,
): number {
  if (!o.checkin || !o.checkout) return 0;
  const s = from && from > o.checkin ? from : o.checkin;
  // to 是「最後一天」，而佔用算到 checkout 的前一晚 —— 兩邊都要 +1 對齊
  const eLimit = to ? addDays(to, 1) : o.checkout;
  const e = eLimit < o.checkout ? eLimit : o.checkout;
  return Math.max(0, daysBetween(s, e));
}

export type Overload = {
  property: string;
  /** 這個範圍的名稱：'2026-10' 或 '篩選期間' */
  scope: string;
  /** 訂單加總的佔用晚數 */
  used: number;
  /** 這個範圍最多有幾晚 */
  limit: number;
  /** 造成過載的訂單 */
  orderIds: string[];
};

export type AuditResult = {
  /** 訂單 id → 問題清單與說明 */
  byId: Record<string, { issues: AuditIssue[]; notes: string[] }>;
  counts: Record<AuditIssue, number>;
  /** 房源過載的細節，給上方摘要用 */
  overloads: Overload[];
  /** 掃了幾筆 */
  scanned: number;
};

const YM = (d: string) => d.slice(0, 7);
const daysInMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * 掃一遍。
 *
 * @param range 使用者在畫面上選的期間。有選就用它當上限，
 *              沒選就按「自然月」逐月檢查 —— 使用者說的是
 *              「A5 在一個月內被住了超過 30 天」，月份是他心裡的單位。
 */
export function auditOrders(
  orders: AuditOrder[],
  range: { from?: string; to?: string } = {},
  opt: {
    /** 目前有效的房源名稱。給了就會檢查「這個房源還在不在清單裡」 */
    knownRooms?: Set<string>;
    /** 判斷年份是否離譜用。傳進來而不是直接 new Date()，測試才穩定 */
    today?: string;
  } = {},
): AuditResult {
  const byId: Record<string, { issues: AuditIssue[]; notes: string[] }> = {};
  const add = (id: string, issue: AuditIssue, note: string) => {
    const r = (byId[id] ??= { issues: [], notes: [] });
    if (!r.issues.includes(issue)) r.issues.push(issue);
    r.notes.push(note);
  };

  /* ── 1. 逐筆：日期與缺漏 ────────────────────── */
  for (const o of orders) {
    // 作廢的單金額本來就是 0，那是正確狀態不是漏填
    if (isVoided(o)) continue;
    const oneoff = ONEOFF.has(String(o.source ?? ''));

    if (o.checkin && o.checkout && !oneoff) {
      if (o.checkout < o.checkin) {
        add(o.id, '日期不合理', `迄日 ${o.checkout} 早於起日 ${o.checkin}`);
      } else if (o.checkout === o.checkin) {
        add(o.id, '日期不合理', '起訖同一天（0 晚）—— 這應該是一次性收入');
      } else if (daysBetween(o.checkin, o.checkout) > 366) {
        // 超過一年的單筆住宿幾乎都是年份打錯（2024 打成 2026）,
        // 真的長租會走契約那條路而不是訂單
        add(o.id, '日期不合理',
          `住 ${daysBetween(o.checkin, o.checkout)} 晚 —— 超過一年，年份是不是打錯了？`);
      }
    }

    /*
     * 年份離譜。
     *
     * 這個專案真的發生過兩次：舊的 key 產生器在跨年日期上算錯年份，
     * 以及使用者手動輸入時把 2026 打成 2024。
     * 兩次都不會報錯 —— 那筆訂單只是安靜地掉到另一年的營收裡。
     */
    if (o.checkin && opt.today) {
      const gap = daysBetween(opt.today, o.checkin);
      if (gap <= -730) {
        add(o.id, '日期不合理', `入住日 ${o.checkin} 在兩年前 —— 年份是不是打錯了？`);
      } else if (gap >= 730) {
        add(o.id, '日期不合理', `入住日 ${o.checkin} 在兩年後 —— 年份是不是打錯了？`);
      }
    }

    /*
     * 缺漏。
     *
     * 房源不列進來 —— 整棟出租、公區費用本來就沒有房號。
     * 把它算成缺漏的話，每次驗算都會跳出一整排本來就正常的資料，
     * 而那會讓人開始忽略所有標記。
     */
    const miss: string[] = [];
    if (!(o.guest_name ?? '').trim()) miss.push('房客');
    if (!o.estate_id) miss.push('物業');
    if (!o.checkin) miss.push('起日');
    if (!oneoff && !o.checkout) miss.push('迄日');
    if (!(Number(o.amount) > 0)) miss.push('金額');
    if (miss.length) add(o.id, '資料缺失', `沒填：${miss.join('、')}`);

    /*
     * 房源名稱對不到現有的房源。
     *
     * 這抓的是「舊舊舊A13(7062)」這種歷史殘留 —— 那些訂單在報表上
     * 會自成一格，看起來像一間不存在的房子在賺錢。
     */
    if (opt.knownRooms && o.property_raw && !opt.knownRooms.has(o.property_raw)) {
      add(o.id, '資料缺失', `房源「${o.property_raw}」不在現有房源清單裡`);
    }
  }

  /* ── 2. 重複訂單 ────────────────────────────── */
  /*
   * 同房源、同起訖、同金額 = 幾乎確定是同一筆被匯入兩次。
   * 姓名刻意**不**列入比對鍵 —— 2026-07 那次就是因為
   * Michael / Michael Hu 被當成兩個人，同一筆變兩列。
   *
   * 移房拆出來的段落（move_group）與加費子單（parent_order_id）
   * 天生就會同房同日期，不能算重複。
   */
  const dup = new Map<string, AuditOrder[]>();
  for (const o of orders) {
    if (!isStay(o) || o.move_group) continue;
    if (!o.property_raw || !o.checkin || !o.checkout) continue;
    const key = `${o.property_raw}|${o.checkin}|${o.checkout}|${Math.round(Number(o.amount) || 0)}`;
    (dup.get(key) ?? dup.set(key, []).get(key)!).push(o);
  }
  for (const group of dup.values()) {
    if (group.length < 2) continue;
    const names = Array.from(new Set(group.map((g) => (g.guest_name ?? '').trim()).filter(Boolean)));
    const note = names.length > 1
      ? `${group.length} 筆同房源、同起訖、同金額，只有姓名不同（${names.join(' / ')}）`
      : `${group.length} 筆完全一樣`;
    for (const g of group) add(g.id, '重複訂單', note);
  }

  /* ── 2b. 期間重疊 ───────────────────────────── */
  /*
   * 同一間房、兩筆訂單的住宿期間有交集。
   *
   * 【為什麼要跟「房源過載」分開抓】
   * 過載是整段期間的加總，抓得到「這個月賣了 45 晚」但講不出是哪兩筆；
   * 重疊是兩兩比對，直接指名道姓。
   *
   * 而且過載會漏掉跨月的情況：兩筆各佔 20 天、重疊 10 天，
   * 分到兩個月看每個月都沒破表，實際上房間被賣了兩次。
   *
   * 2026-08 的真實例子：A15 劉令儀 7/22–10/09 與 智宜 7/30–8/31 重疊 32 天。
   */
  const byRoomStay = new Map<string, AuditOrder[]>();
  for (const o of orders) {
    if (!isStay(o) || !o.property_raw || !o.checkin || !o.checkout) continue;
    if (o.checkout <= o.checkin) continue;
    const k = o.property_raw;
    (byRoomStay.get(k) ?? byRoomStay.set(k, []).get(k)!).push(o);
  }
  for (const [room, list] of byRoomStay) {
    const sorted = [...list].sort((a, b) => a.checkin!.localeCompare(b.checkin!));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i], b = sorted[j];
        // 排序過了：b 的起日已經不早於 a，b 起日 >= a 迄日就不可能再有交集，
        // 後面的更不可能 —— 直接跳出內圈
        if (b.checkin! >= a.checkout!) break;
        // 移房拆出來的段落屬於同一筆訂單，本來就會接在一起
        if (a.move_group && a.move_group === b.move_group) continue;
        const s = a.checkin! > b.checkin! ? a.checkin! : b.checkin!;
        const e = a.checkout! < b.checkout! ? a.checkout! : b.checkout!;
        const n = daysBetween(s, e);
        if (n <= 0) continue;
        const note = `${room} 與另一筆重疊 ${n} 晚（${s} ~ ${e}）：`
          + `${(a.guest_name ?? '?').trim()} ${a.checkin}~${a.checkout} / `
          + `${(b.guest_name ?? '?').trim()} ${b.checkin}~${b.checkout}`;
        add(a.id, '重複訂單', note);
        add(b.id, '重複訂單', note);
      }
    }
  }

  /* ── 3. 房源過載 ────────────────────────────── */
  /*
   * 【為什麼用「訂單加總」而不是「合併重疊區間」】
   *
   * 使用者要的是「這間房這個月被賣了幾晚」。合併區間會把
   * 兩筆重疊的訂單算成一段，剛好把要抓的問題藏起來 ——
   * 而重複計費正是這裡最貴的錯。
   */
  const overloads: Overload[] = [];
  const stays = orders.filter((o) => isStay(o) && o.property_raw
    && o.checkin && o.checkout && o.checkout > o.checkin);

  if (range.from && range.to) {
    const limit = daysBetween(range.from, range.to) + 1;
    const acc = new Map<string, { used: number; ids: string[] }>();
    for (const o of stays) {
      const n = nightsInRange(o, range.from, range.to);
      if (n <= 0) continue;
      const room = o.property_raw!;
      const cur = acc.get(room) ?? { used: 0, ids: [] };
      cur.used += n; cur.ids.push(o.id);
      acc.set(room, cur);
    }
    for (const [room, v] of acc) {
      if (v.used > limit) {
        overloads.push({ property: room, scope: '篩選期間', used: v.used, limit, orderIds: v.ids });
        for (const id of v.ids) {
          add(id, '房源過載', `${room} 在篩選期間被訂了 ${v.used} 晚，但這段期間只有 ${limit} 天`);
        }
      }
    }
  } else {
    // 沒選期間 → 按自然月。使用者說的「一個月內超過 30 天」就是這個單位
    const acc = new Map<string, { used: number; ids: string[] }>();
    for (const o of stays) {
      // 一筆訂單可能跨月，每個月各算各的
      for (let d = o.checkin!; d < o.checkout!; d = addDays(d, 1)) {
        const key = `${o.property_raw}|${YM(d)}`;
        const cur = acc.get(key) ?? { used: 0, ids: [] };
        cur.used += 1;
        if (!cur.ids.includes(o.id)) cur.ids.push(o.id);
        acc.set(key, cur);
      }
    }
    for (const [key, v] of acc) {
      const [room, ym] = key.split('|');
      const limit = daysInMonth(ym);
      if (v.used > limit) {
        overloads.push({ property: room, scope: ym, used: v.used, limit, orderIds: v.ids });
        for (const id of v.ids) {
          add(id, '房源過載', `${room} 在 ${ym} 被訂了 ${v.used} 晚，但那個月只有 ${limit} 天`);
        }
      }
    }
  }
  overloads.sort((a, b) => (b.used - b.limit) - (a.used - a.limit));

  /* ── 4. 房價過低 ────────────────────────────── */
  /*
   * 跟同房源的均價比，不是跟全站比 —— A15 跟 B7 的價位本來就不同。
   * 均價用「總額 ÷ 總晚數」，不是每筆單價再平均：
   * 後者會讓一筆一晚跟一筆三十晚一樣重，而三十晚那筆通常是長住優惠價。
   */
  const byRoom = new Map<string, AuditOrder[]>();
  for (const o of stays) {
    if (!(Number(o.amount) > 0)) continue;
    const room = o.property_raw!;
    (byRoom.get(room) ?? byRoom.set(room, []).get(room)!).push(o);
  }
  for (const [room, list] of byRoom) {
    if (list.length < AUDIT_MIN_SAMPLE) continue;
    const sumAmt = list.reduce((a, o) => a + Number(o.amount), 0);
    const sumNt = list.reduce((a, o) => a + daysBetween(o.checkin!, o.checkout!), 0);
    if (sumNt <= 0) continue;
    const avg = sumAmt / sumNt;
    for (const o of list) {
      const n = daysBetween(o.checkin!, o.checkout!);
      if (n <= 0) continue;
      const nightly = Number(o.amount) / n;
      if (nightly < avg * AUDIT_LOW_RATIO) {
        add(o.id, '房價過低',
          `每晚 $${Math.round(nightly).toLocaleString('en-US')}，`
          + `${room} 均價 $${Math.round(avg).toLocaleString('en-US')}`
          + `（${Math.round((nightly / avg) * 100)}%）`);
      }
    }
  }

  const counts = {
    重複訂單: 0, 房源過載: 0, 資料缺失: 0, 房價過低: 0, 日期不合理: 0,
  } as Record<AuditIssue, number>;
  for (const v of Object.values(byId)) for (const i of v.issues) counts[i]++;

  return { byId, counts, overloads, scanned: orders.length };
}

/** 標記的顏色。同一種問題在訂單頁與營收頁要長得一樣。 */
export const ISSUE_CLS: Record<AuditIssue, string> = {
  重複訂單: 'bg-red-50 text-red-700 border-red-200',
  房源過載: 'bg-orange-50 text-orange-700 border-orange-200',
  日期不合理: 'bg-red-50 text-red-700 border-red-200',
  資料缺失: 'bg-amber-50 text-amber-800 border-amber-200',
  房價過低: 'bg-mor-bluelight text-mor-slate border-mor-slate/30',
};
