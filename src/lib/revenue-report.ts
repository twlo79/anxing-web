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
  return `${r.fee_type || ROOM_NONE}・${r.item_name || ROOM_NONE}`;
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
