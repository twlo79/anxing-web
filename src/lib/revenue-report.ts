/**
 * 營收報表的分段與彙總。**只算數字,不管版面。**
 *
 * 為什麼要抽出來:版面歪了看一眼就知道,數字錯了不會有任何徵兆。
 * 2026-08 財務儀表板顯示營收 0(實際上八百多萬)就是這樣過去的 ——
 * 查詢條件寫錯,不報錯,只是安靜地回空集合。所以會算錢的部分要有測試。
 *
 * 【三段怎麼分】
 *   物業段    短租(Airbnb/Agoda/私下)+ 長租 + 一次性 + 其他
 *   辦公室段  office
 *   公司登記段 company
 *
 * 辦公室出租與公司登記不掛物業房源 —— 它們不是租金收入,
 * 混進物業會讓「這個物業帶進多少錢」失真。
 *
 * 三段相加必須等於總營收。那是內建的對帳點,不用另外寫檢查程式。
 */

export type RevRow = {
  source: string;
  estate_name: string | null;
  property_raw: string | null;
  guest_name: string | null;
  month_amount: number | string;
  /** 一次性收入的會計科目(清潔費…)。 */
  fee_type?: string | null;
  /** 一次性收入的項目(洗衣機/垃圾代收費…)。會計科目底下再細一層。 */
  item_name?: string | null;
};

/**
 * source='oneoff' 這一類的顯示名稱,**全站只定義這一次**。
 *
 * 內容是清潔費、修繕費、水電費、取消費、垃圾代收費、洗衣機收入、折讓(負數)…
 * 共同點是「不是租金的收入」。
 *
 * 【為什麼不叫「一次性收入」】
 * 定期收費上線後,洗衣機每月都有、垃圾代收費每月固定 5,070 ——
 * 那些不是一次性。名字跟內容對不上會讓看報表的人誤判。
 *
 * 【為什麼要集中定義】
 * 之前同一筆錢有四個名字:短租頁叫「其他收入(一次性)」、營收頁叫「其他收入」、
 * Excel 總表叫「一次性費用」、Excel 分類欄叫「一次性」。
 * 對帳的人得自己在腦裡對應,而且改名時必然漏掉幾處。
 */
export const ONEOFF_LABEL = '其他收入';

/**
 * 營收來源的顯示名稱,**全站只定義這一次**。
 *
 * 儀表板原本自己寫了一份而且漏了 office 與 company,結果畫面上直接吐出
 * 資料庫的英文鍵 —— 使用者看到「office」「company」不知道那是什麼。
 * 少寫兩個鍵不會報錯,只會安靜地把英文顯示出來,所以要有單一來源。
 */
export const SOURCE_LABEL: Record<string, string> = {
  airbnb: 'Airbnb',
  agoda: 'Agoda',
  private: '私下',
  longterm: '長租',
  office: '辦公室租賃',
  company: '公司登記',
  oneoff: ONEOFF_LABEL,
  other: '其他',
  partner: '搭檔收款',
  airbnb_cancelled: 'Airbnb 取消',
};
/** 顯示名稱。沒對應到就回原始鍵 —— 至少看得出是哪個來源,而不是空白。 */
export const srcLabel = (s: string) => SOURCE_LABEL[s] ?? s;

/** 認列表裡實際會出現的來源。partner 在寫入時已歸到 airbnb,airbnb_cancelled 歸到 oneoff。 */
export const SHORT_SOURCES = ['airbnb', 'agoda', 'private'];

export const isOffice = (r: RevRow) => r.source === 'office';
export const isCompany = (r: RevRow) => r.source === 'company';
/** 物業段:辦公室與公司登記以外的全部 */
export const inEstateBlock = (r: RevRow) => !isOffice(r) && !isCompany(r);

export const estateOf = (r: RevRow) => r.estate_name ?? '無物業';
export const guestOf = (r: RevRow) => r.guest_name ?? '未填客戶';
/**
 * 房源空值的顯示。
 *
 * 空值有兩種來源,而且分不出來:
 *   刻意留白 —— 這筆錢算在整棟上（公區清潔、整棟修繕、管理費分攤）
 *   真的沒填 —— 匯入時漏掉、或建單時忘了選
 *
 * 表格裡一律寫破折號,不寫「整棟」也不寫「未指定」——
 * 寫「整棟」會讓漏填的資料看起來是正常的,寫「未指定」又會讓刻意留白的看起來像錯誤。
 * 破折號只陳述「這一格沒有值」,不替使用者解釋原因。
 */
export const ROOM_NONE = '—';
export const roomOf = (r: RevRow) => r.property_raw ?? ROOM_NONE;

/** 房源月報的分類欄 */
export function classOf(r: RevRow): string {
  if (SHORT_SOURCES.includes(r.source)) return '短租';
  if (r.source === 'longterm') return '長租';
  if (r.source === 'oneoff') return ONEOFF_LABEL;
  return '其他';
}

/**
 * 分類 + 項目。一次性收入才有項目。
 *
 * 洗衣機、烘衣機、垃圾代收費的會計科目都是「清潔費」,只看科目會併成一格 ——
 * 這一層就是為了把它們拆開。沒有項目的維持只顯示分類,不要留一個
 * 「一次性・」這種尾巴空著的字串。
 */
export function itemLabel(r: RevRow): string {
  const c = classOf(r);
  return c === ONEOFF_LABEL ? `${c}・${oneoffLabel(r)}` : c;
}

/**
 * 一次性收入的細分標籤:`會計科目・項目`。
 *
 * 兩層都要顯示 —— 科目是給會計看的分類(清潔費),項目是給營運看的明細(洗衣機)。
 * 只有科目的話,洗衣機/烘衣機/垃圾代收費會全部併成一格「清潔費」。
 * 空的一律寫破折號,不要留 `清潔費・` 這種尾巴空著的字串。
 */
export function oneoffLabel(r: RevRow): string {
  const code = r.fee_type || ROOM_NONE;
  /*
   * ★★ 沒有項目就**不接第三段**（2026-09-02 使用者:「為何後面有空」）。
   *
   *   原本一律補破折號，於是多數列長成「其他收入・管理費・—」——
   *   而那個破折號不帶任何訊息:管理費本來就沒有細項。
   *
   * ★ 但**科目**沒填還是寫破折號。那是異常（一次性收入沒有會計科目），
   *   要看得見；項目沒填是常態。兩個空值的意義不一樣。
   *
   * ★★★ 這支同時是**分組的鍵**（`oneoffItems`）與顯示的標籤。
   *   兩邊一起變才不會出現「篩選器有這一項、清單卻是另一個字」
   *   —— 所以只能改這裡，不能在畫面上另外處理。
   */
  return r.item_name ? `${code}・${r.item_name}` : code;
}

/** 一次性收入依「科目・項目」彙總,金額大到小。 */
export function oneoffItems(rows: RevRow[]): { item: string; amount: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.source !== 'oneoff') continue;
    const k = oneoffLabel(r);
    m.set(k, (m.get(k) ?? 0) + Number(r.month_amount || 0));
  }
  return [...m.entries()]
    .map(([item, amount]) => ({ item, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount);
}

/** 加總。字串金額也要吃 —— Supabase 的 numeric 回來是字串。 */
export function sum(rows: RevRow[], f: (r: RevRow) => boolean = () => true): number {
  return Math.round(rows.filter(f).reduce((a, r) => a + Number(r.month_amount || 0), 0));
}

/**
 * 列骨架:掃過**所有月份**取聯集。
 *
 * 這是這一版最重要的改變。舊版每個月各自長出自己的標籤(有值才長一列),
 * 8 月的物業有 5 個、7 月有 6 個,兩邊的列就從那裡開始錯開 ——
 * 同一列左右兩個數字不是同一個科目,橫著讀是錯的。
 *
 * 取聯集之後每一列在所有月份都存在,沒有值就是 0。
 */
export function skeleton(allRows: RevRow[], estateOrder: (a: string, b: string) => number) {
  const uniq = (xs: string[]) => Array.from(new Set(xs));
  return {
    estates: uniq(allRows.filter(inEstateBlock).map(estateOf)).sort(estateOrder),
    offices: uniq(allRows.filter(isOffice).map(guestOf)).sort(),
    companies: uniq(allRows.filter(isCompany).map(guestOf)).sort(),
  };
}

/**
 * 房源段的列:粒度是 物業 x 房源 x 分類(含項目)。
 *
 * 一個房間同一個月可能同時有長租與一次性,合成一列就看不出組成。
 * 一次性再依項目拆 —— 洗衣機與烘衣機的科目都是清潔費,不拆就併成一列。
 */
export function roomLines(allRows: RevRow[], estate: string) {
  const inEstate = (r: RevRow) => inEstateBlock(r) && estateOf(r) === estate;
  // Map 的鍵只用來去重,不參與顯示。分隔用 \u001F(單元分隔字元)——
  // 它不可能出現在房號或項目名稱裡;用空格或「.」的話,名稱裡剛好有那個字就會撞在一起。
  const seen = new Map<string, { room: string; cls: string }>();
  for (const r of allRows.filter(inEstate)) {
    const room = roomOf(r), cls = itemLabel(r);
    seen.set(room + '\u001F' + cls, { room, cls });
  }
  return Array.from(seen.values());
}

/**
 * 對帳:三段相加要等於總營收。
 * 回傳 null 代表沒問題;有值代表差額,呼叫端應該讓它顯眼。
 */
export function reconcile(rows: RevRow[]): { total: number; parts: number; diff: number } | null {
  const total = sum(rows);
  const parts = sum(rows, inEstateBlock) + sum(rows, isOffice) + sum(rows, isCompany);
  return total === parts ? null : { total, parts, diff: total - parts };
}

/**
 * 「一次性收入」有哪些來源（2026-08-25 使用者:「勾選 去除一次性收入 之後就是 比房租」）。
 *
 * ============================================================
 * 【為什麼要能去掉它】
 *
 * 一次性收入是清潔費、修繕費、取消費那一類 —— 金額跳動很大，
 * 而且**跟這個月租得好不好無關**。
 *
 *   8 月營收掉 15%，其中一次性收入從 110 萬掉到 4 萬
 *   → 房租其實沒動，是上個月有一筆大修繕費入帳
 *
 * 混在一起的時候這兩件事分不出來，而**每個數字單看都正確**。
 * 去掉之後那張表問的才是「房租」。
 *
 * ============================================================
 * 【為什麼是一份清單而不是 `s === 'oneoff'`】
 *
 * `airbnb_cancelled`（取消收入）在寫入認列表時已經歸到 `oneoff`，
 * 所以現在只會有一種。但那是**寫入端的行為**，不是這裡的保證 ——
 * 哪天有人在別的地方直接寫 `airbnb_cancelled` 進來，
 * 「去除一次性收入」就會漏掉它，而總數只是少扣一點，
 * 不會有任何跡象。列成清單，兩種都擋。
 *
 * ★ `other` **不在**清單裡:那是會計科目「其他」，
 *   跟來源「其他收入」不是同一個東西（fee-types.ts 的檔頭有說）。
 */
export const ONEOFF_SOURCES = ['oneoff', 'airbnb_cancelled'];

/** 這一筆是不是一次性收入。傳來源字串,不是整列 —— 認列與訂單兩邊都用得到。 */
export const isOneoffSource = (s: string | null | undefined) =>
  ONEOFF_SOURCES.includes(s ?? '');

/** 只留房租（去掉一次性收入）。`on` 是 false 時原封不動回傳同一個陣列。 */
export function rentOnly<T extends { source: string }>(rows: T[], on: boolean): T[] {
  return on ? rows.filter((r) => !isOneoffSource(r.source)) : rows;
}
