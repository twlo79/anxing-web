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
  /**
   * 這筆收入**掛不掛物業**（migration_235）。`estate` / `office` / `other_biz`。
   *
   * ★★★ 跟 `source='office'` 是**兩個不同的軸**，名字剛好撞在一起:
   *
   *     source        這是哪一種收入   辦公室出租 / 公司登記 / 一次性 / 短租…
   *     purpose_type  掛不掛物業       estate（掛）/ office（安幸自己）
   *
   *   辦公室出租、公司登記、房務收入三者的 purpose_type 都是 `office`
   *   （都不掛物業），但 source 分別是 office / company / oneoff ——
   *   所以報表的三個區塊照舊分得開。
   *
   * ★ 選填:migration_235 之前的資料沒有這一欄，
   *   底下的判斷會退回舊的 source 列舉（見 `inEstateBlock`）。
   */
  purpose_type?: string | null;
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

/** 辦公室**出租** —— 安幸把辦公室租給別人的租金。不是「安幸辦公室」。 */
export const isOffice = (r: RevRow) => r.source === 'office';
export const isCompany = (r: RevRow) => r.source === 'company';

/** 安幸辦公室（總部）自己的收入 —— 房務清潔、人事費那一類。 */
export const OFFICE_NAME = '安幸辦公室';

/**
 * 安幸辦公室自己的收入（房務清潔、人事費…）。
 *
 * ★★ 條件裡要**排除辦公室出租與公司登記** —— 那兩種的 purpose_type
 *   也是 `office`（同樣不掛物業），但它們各自有獨立的區塊。
 *   不排除的話同一筆錢會被算進兩段，而三段相加就對不上總營收。
 */
export const isHkOffice = (r: RevRow) =>
  r.purpose_type === 'office' && !isOffice(r) && !isCompany(r);

/**
 * 這筆收入算不算在「依物業」那一段裡。
 *
 * ============================================================
 * 【★★★ 為什麼從列舉 source 改成看 purpose_type】（2026-09-09）
 *
 * 舊寫法是 `!isOffice(r) && !isCompany(r)` —— 它想問的是
 * 「這筆收入掛不掛物業」，但問不到那個欄位，只好把不掛的那幾種列出來。
 *
 * ★★ 結果是**每多一種不掛物業的收入，這一行就要多一個 `&&`**，
 *   而漏加不會報錯 —— 那筆錢會安靜地混進某個物業的小計。
 *   房務收入就是第三種（migration_228 那次我用假物業繞過去，
 *   於是安幸辦公室變成第九棟樓）。
 *
 * ★ migration_235 給 orders 與認列表加了 `purpose_type`，
 *   這一行從此不用再改。
 *
 * ============================================================
 * 【為什麼保留舊路當退路】
 *
 * 這一欄是 2026-09-09 才加的。前端先上線、migration 還沒跑的那幾分鐘，
 * `purpose_type` 會是 undefined —— 那時候退回舊的列舉，數字完全不變。
 *
 * ★ 兩條路對既有資料**答案一模一樣**（migration_235 自檢第 ③ 條驗過），
 *   所以這個退路不會讓兩種環境算出不同的營收。
 */
export const inEstateBlock = (r: RevRow) =>
  r.purpose_type ? r.purpose_type === 'estate' : (!isOffice(r) && !isCompany(r));

/**
 * 這一列的物業名稱。
 *
 * ★★ 安幸辦公室的收入**沒有物業**（`estate_name` 是 null），
 *   但畫面上不能寫「無物業」—— 那看起來像資料漏填。
 *   它有明確的歸屬，只是那個歸屬不是一棟樓。
 */
export const estateOf = (r: RevRow) =>
  r.estate_name ?? (r.purpose_type === 'office' ? OFFICE_NAME : '無物業');
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
  const item = (r.item_name ?? '').trim();
  if (!item) return code;
  /*
   * ★★ 項目本身就以科目開頭時**不要再印一次**（2026-09-09）。
   *
   *   房務清潔的項目是「房務清潔 14B3」（跟支出那一筆同名，
   *   刻意的 —— 成對的兩筆要對得起來），
   *   照舊拼的話標籤會變成「一次性收入・房務清潔・房務清潔 14B3」。
   *
   * ★ 修在這裡而不是把項目名稱改短:名字是給**兩張表對帳**用的,
   *   重複只是這一個標籤的顯示問題。
   */
  if (item === code || item.startsWith(`${code} `)) return item;
  return `${code}・${item}`;
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
    /*
     * ★★ 房務收入依**付錢的物業**分列 —— 那個值放在「客戶」欄
     *   （產生時寫的是「向誰收」）。跟辦公室出租同一種做法。
     */
    hkPayers: uniq(allRows.filter(isHkOffice).map(guestOf)).sort(estateOrder),
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
  /*
   * ★★★ **四段**，不是三段（2026-09-09 加了房務收入）。
   *
   *   migration_235 之前房務收入的 source 是 oneoff、沒有 purpose_type,
   *   所以它落在 `inEstateBlock` 裡 —— 三段就蓋得完。
   *   235 之後它被排除在物業段之外，**不補上第四段的話這裡永遠差一截**,
   *   而畫面上會是一個沒有人知道從哪來的差額。
   *
   * ★ 這支函式就是為了抓這種事而存在的。新增一種區塊就要回來加一項。
   */
  const parts = sum(rows, inEstateBlock) + sum(rows, isOffice)
    + sum(rows, isCompany) + sum(rows, isHkOffice);
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
