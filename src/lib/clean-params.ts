/**
 * 清潔計算的四個參數（純函式）。
 *
 * ============================================================
 * 【這是什麼】（2026-09-03 使用者:「房源管理 切出 清潔計算」）
 *
 *   1. 床位       `properties.beds`         布巾組數 ＝ 床數 × 打掃次數
 *   2. 打掃點數   `properties.clean_points` 報酬點數 ＝ 打掃量 × 這個值（算薪）
 *   3. 清潔費     `properties.clean_price`  一份工付多少錢（算支出）
 *   4. 人事費     `hk_labor_cost`           一個月固定，跟打掃次數無關
 *
 * ★★ 前三個在 `properties`，第四個在另一張表 —— 畫面上排在一起，
 *   但寫入是兩條路。這個檔把**驗證規則**收在一處，
 *   四個欄位本來各自 inline 一份正規表示式（而且已經不一致:
 *   床數不收小數、點數收一位、清潔費收兩位）。
 *
 * ============================================================
 * 【★★★ 為什麼「沒設」跟「0」必須分開】
 *
 * 沒設 = null = **不產生支出**；0 = 免費，產生一筆 $0（其實也被擋掉）。
 * 兩者在畫面上都是一個空格子，但帳上差一截 ——
 * 而少掉的那一截沒有任何地方會叫（migration_206）。
 *
 * 所以每一支 parse 都回 `null` 而不是 `0` 來表示留空。
 */

export type ParseOk = { ok: true; value: number | null };
export type ParseErr = { ok: false; error: string };
export type ParseResult = ParseOk | ParseErr;

const ok = (value: number | null): ParseOk => ({ ok: true, value });
const err = (error: string): ParseErr => ({ ok: false, error });

/**
 * 共用的數字解析。
 *
 * ★ 千分位逗號先拿掉 —— 使用者從 Excel 貼過來就是 `200,000`，
 *   直接判定失敗的話他會以為系統壞了（而他只是複製貼上）。
 * ★★ 不收負數:`-` 根本不在正規表示式裡，所以 `-5` 會被擋下來
 *   而不是變成 -5。付一筆負的清潔費不是任何人想做的事。
 */
function parseNum(raw: string, decimals: number, label: string): ParseResult {
  const v = (raw ?? '').trim().replace(/,/g, '');
  if (v === '') return ok(null);
  const re = decimals === 0
    ? /^\d+$/
    : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!re.test(v)) {
    return err(decimals === 0
      ? `${label}只能是 0 以上的整數`
      : `${label}只能是 0 以上的數字（可帶 ${decimals} 位小數）`);
  }
  return ok(Number(v));
}

/** 床位。★ 整數 —— 半張床不存在。公區填 0 代表確定不算床。 */
export const parseBeds = (raw: string) => parseNum(raw, 0, '床位');

/** 打掃點數。難度係數，一位小數（合掃會出現 .5）。 */
export const parsePoints = (raw: string) => parseNum(raw, 1, '打掃點數');

/** 清潔費。兩位小數（有些是拆帳後的零頭）。 */
export const parsePrice = (raw: string) => parseNum(raw, 2, '清潔費');

/** 人事費。整數 —— 月薪不會有零頭，而收小數只會讓人打錯不自知。 */
export const parseLabor = (raw: string) => parseNum(raw, 0, '人事費');

/**
 * 這個物業的人事費該怎麼填。
 *
 * ============================================================
 * 【★★★ 整棟與逐間互斥】
 *
 * `hk_labor_cost` 的約束是「estate_id 與 property_id 擇一」，
 * 但那只管**單獨一列**合不合法 —— 資料庫**不擋**同一個物業
 * 既有整棟 200,000、底下每間又各填一筆。
 * 那樣會兩邊都產生支出，而總額看起來只是「比較大」，沒有錯誤。
 *
 * 所以互斥要在這裡判斷:整棟填了，逐間就鎖起來（反之亦然）。
 *
 * ★ 正隆是整棟 200,000（正隆沒有「整棟」那個房源，塞不進 properties）；
 *   開封是每間一個金額（1F 4,000、2-1 12,000⋯）。兩種都要支援。
 */
export type LaborMode = 'none' | 'estate' | 'rooms';

export function laborMode(
  estateAmount: number | null | undefined,
  roomAmounts: (number | null | undefined)[],
): LaborMode {
  if (estateAmount != null) return 'estate';
  if ((roomAmounts ?? []).some((a) => a != null)) return 'rooms';
  return 'none';
}

/** 整棟那一格可不可以填。★ 已經有逐間的就不行。 */
export const canEditEstateLabor = (m: LaborMode) => m !== 'rooms';

/** 某一間的人事費可不可以填。★ 已經有整棟的就不行。 */
export const canEditRoomLabor = (m: LaborMode) => m !== 'estate';

/**
 * 鎖住時要說什麼。★ 要講**為什麼**與**怎麼解開** ——
 * 只把欄位變灰的話，使用者不知道是壞了還是故意的。
 */
export function laborLockMsg(m: LaborMode, which: 'estate' | 'room'): string | null {
  if (which === 'estate' && m === 'rooms') {
    return '已經逐間設了人事費。要改成整棟一筆，先把下面各間的清空。';
  }
  if (which === 'room' && m === 'estate') {
    return '已經設了整棟人事費。要改成逐間，先把上面那一列清空。';
  }
  return null;
}

/**
 * 這個物業還缺什麼。
 *
 * ★★ 回傳的是**缺的房源名**不是筆數 —— 「3 間沒設」要人自己去一列列找，
 *   而那張表有 74 列（正隆）。
 */
export type CleanGap = {
  beds: string[];
  points: string[];
  price: string[];
};

export function cleanGaps(
  rooms: { name: string; beds?: number | null; clean_points?: number | null; clean_price?: number | null }[],
): CleanGap {
  const rs = rooms ?? [];
  return {
    beds: rs.filter((r) => r.beds == null).map((r) => r.name),
    points: rs.filter((r) => r.clean_points == null).map((r) => r.name),
    price: rs.filter((r) => r.clean_price == null).map((r) => r.name),
  };
}

/** 有沒有任何缺口 —— 沒有的話整塊警告不要出現。 */
export const hasGap = (g: CleanGap) => !!(g.beds.length || g.points.length || g.price.length);
