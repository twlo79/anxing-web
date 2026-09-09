/**
 * 房務的成對分錄 —— 一份工要記幾筆、記到誰頭上。
 *
 * ============================================================
 * 【★★★ 為什麼一份工不再只是一筆支出】（2026-09-07 使用者指定）
 *
 * 房務是**安幸對物業提供的服務**。以前只記「物業付了多少」,
 * 於是安幸這門生意在帳上完全看不到 —— 沒有收入、沒有成本、沒有毛利。
 *
 * 現在一份工是一組分錄:
 *
 *   安幸辦公室 收入   房務清潔   間 × 單價      ← 安幸賺的
 *   物業 房源  支出   房務清潔   間 × 單價      ← 物業付的（同額，反向）
 *   安幸辦公室 支出   薪資勞務   時數 × 時薪    ← 只有時薪人員做的才有
 *
 * ★★ 前兩筆**同額**（2026-09-07 使用者確認）。所以 Una／庭玉 做的工,
 *   安幸有收入而沒有對應成本 —— 她們的酬勞不經過這個系統,那是事實,
 *   不是漏算。
 *
 * ★★★ 第三筆才是安幸的成本。**只有劉姐（時薪制）有** ——
 *   她是安幸的人，物業付的那筆錢跟她拿多少沒有關係。
 *
 *
 * ============================================================
 * 【合掃:一整間不打折，再加時薪】
 *
 * 14B3 是庭玉跟劉姐一起掃的。收入／支出那一對**照樣算一整間**
 * （2026-09-07 使用者:「一起算掃一間」），劉姐的時薪另外加。
 *
 * ★ 打折的話庭玉那半份工的錢會默默少掉,而她是按間計酬的 ——
 *   那份工對她沒有因為旁邊多一個人而變便宜。
 *
 *
 * ============================================================
 * 【★★★ 收入寫進 orders，冪等靠 order_key】
 *
 * 一次性收入是 `orders`,那張表**沒有 `hk_job_key`** ——
 * 支出那套的唯一索引在這裡用不上。
 *
 * 但 `orders.order_key` 本身就是唯一的（`orders_order_key_key`）,
 * 所以收入用 `HKREV|日期|房源|工作類型` 當 order_key,
 * 走同一種 upsert ＋ ignoreDuplicates —— **按兩次不會變兩倍**。
 *
 * ★ 前綴一定要有。不加的話它會長得跟支出那邊的 `日期|房源|類型` 一樣,
 *   而那兩個 key 分別存在兩張表裡,將來對帳時分不出誰是誰。
 */

/** 會計科目。三個都在 `account_codes` 裡（migration_228）。 */
import { cleanItemName } from './hk-cost.ts';

export const CODE_CLEAN = 'hk_cleaning';   // 房務清潔（kind=both，收支兩端共用）
export const CODE_SALARY = 'salary';       // 薪資勞務（支出）
export const CODE_LABOR_REV = 'hk_labor';  // 人事費（收入）

/** 安幸辦公室那個房源的名字（migration_228 建的）。 */
export const OFFICE_NAME = '安幸辦公室';

/**
 * 人事費要對安幸開收入的物業（2026-09-07 使用者:「只有正隆的 20 萬」）。
 *
 * ★★★ 這是**寫死的名字**（使用者選「程式裡認正隆這個名字」）。
 *   物業一改名這條就失效,而失效的症狀是
 *   **安幸少了一筆 20 萬收入** —— 不會報錯、不會有紅字,
 *   只是那個月的收入少一截。
 *
 * ★ 所以底下有一條測試釘住這個名字。哪天真的改名了,
 *   測試會先壞掉,而不是等會計月結時才發現。
 */
export const LABOR_BILL_TO_OFFICE: readonly string[] = ['正隆'];

export type EntrySide = 'income' | 'expense';

export type HkEntry = {
  /** 冪等鍵。支出 → `hk_job_key`／`hk_labor_key`；收入 → `order_key`。 */
  key: string;
  side: EntrySide;
  /** 打掃日（收入的 checkin＝checkout 也是它）。 */
  on: string;
  item_name: string;
  amount: number;
  account_code: string;
  /**
   * 記到哪個房源。
   *
   * ★ 收入與劉姐的薪資一律**安幸辦公室**；清潔費才是真正的房源。
   *   `null` = 還沒對到房源，呼叫端要補（見 `fillEstate`）。
   */
  property_id: string | null;
  /** 這一筆屬於安幸辦公室 —— 支出端要寫 `purpose_type='office'`。 */
  office: boolean;
  /**
   * 收入是向誰收的（物業名稱）。寫進訂單的「房客」欄。
   *
   * ★ 支出沒有這個概念,留 undefined。
   */
  payer?: string;
  /**
   * 這一筆是哪一間房的工。寫進訂單的「備註」欄
   * （2026-09-08 使用者:「備註：房號 房源」）。
   *
   * ★★ 收入列的房源欄是**空的** —— 安幸辦公室不是真的房間,
   *   填進去只會讓營收頁一整排長一樣、房源下拉多一個假房號。
   *   所以房號改走備註。
   *
   * ★ 備註**不在營收清單上**（`revenue_recognitions` 沒有 `note`,
   *   只有點開單筆的抽屜才讀得到訂單本體）——
   *   所以 `item_name` 那邊**也要留著房號**，那一欄清單上看得到。
   *   兩邊都寫不是重複,是「清單上看得到」與「明細查得到」兩件事。
   *
   * ★ 人事費那一對沒有房號,留 undefined。
   */
  room?: string;
};

/** 一份工（`estateLog()` 攤平後取用得到的欄位）。 */
export type JobLike = {
  work_date: string;
  property_id: string | null;
  work_type: string;
  label: string;
};

/**
 * 清潔那一對:安幸收入 ＋ 物業支出，**同額反向**。
 *
 * @param costRows `cleaningCosts()` 算好的物業支出
 *
 * ★★★ 2026-09-09 起 `property_id` 一律 `null`（migration_235）——
 *   安幸辦公室不再是一個假物業/假房源,它是 `purpose_type='office'`。
 *   收入掛在「用途」上，不掛任何房源。
 *
 * ★★ 直接吃 `cleaningCosts` 的結果,不重算一次金額 ——
 *   重算的話兩邊遲早會漂,而漂掉的症狀是「收入跟支出對不起來」,
 *   金額都很正常,只是差幾百塊,沒有人查得出來。
 */
export function cleaningIncome(
  costRows: {
    key: string; work_date: string; amount: number; label: string;
    property_id: string | null;
    /** 給 `cleanItemName()` 用 —— 沒帶就不印「×N」 */
    units?: number; fixedAmount?: boolean;
  }[],
  /**
   * 這一份工是向誰收的（物業名稱）。
   *
   * ★★ 收入列的房源是「安幸辦公室」,所以**不寫付款方的話，
   *   營收頁上一整排都長一樣** —— 只看得到「房務清潔 A09」,
   *   看不出這 730 是向時兆還是向開封收的。
   */
  payerOf: (propertyId: string | null) => string,
): HkEntry[] {
  return (costRows ?? [])
    .filter((r) => r.amount !== 0)
    .map((r) => ({
      // ★ `HKREV|` 前綴 —— 不加的話跟支出的 key 長得一樣，兩張表對不出誰是誰
      key: `HKREV|${r.key}`,
      side: 'income' as const,
      on: r.work_date,
      /*
       * ★★★ 項目名稱**跟支出那一筆一模一樣**（2026-09-09 使用者:
       *   「收入 也叫 房務清潔 房源」）。
       *
       *   同一支 `cleanItemName()` 產生,不是各拼各的字串 ——
       *   成對的兩筆在兩張表上要對得起來,名字不一樣的話
       *   核帳的人得自己猜哪一筆配哪一筆。
       *
       * ★ 我 2026-09-08 一度把收入這邊改成只放房號,理由是
       *   營收清單的標籤會變成「房務清潔・房務清潔 14B3」。
       *   那個重複改在 `oneoffLabel()` 修（科目與項目開頭相同就不重印），
       *   不是把兩邊的名字弄得不一樣。
       */
      item_name: cleanItemName(r.label, Number(r.units), r.fixedAmount),
      amount: r.amount,
      account_code: CODE_CLEAN,
      property_id: null,
      office: true,
      payer: payerOf(r.property_id),
      room: r.label || undefined,
    }));
}

/**
 * 人事費那一對。**只有指定的那一筆成對**
 * （2026-09-07 使用者:「只有正隆的 20 萬」）。
 *
 * ★★ 其餘幾筆維持現狀:只有物業支出，沒有安幸收入。
 *   全部成對的話，安幸的收入會憑空多出那幾筆 ——
 *   而那幾筆本來就不是安幸收的錢。
 *
 * @param pairEstates 要成對的物業 id（正隆）
 */
export function laborIncome(
  labRows: { key: string; spent_on: string; estate_id: string | null; amount: number }[],
  pairEstates: ReadonlySet<string>,
  estateName: (id: string) => string,
): HkEntry[] {
  return (labRows ?? [])
    .filter((r) => r.estate_id && pairEstates.has(r.estate_id) && r.amount !== 0)
    .map((r) => ({
      key: `HKLABREV|${r.key}`,
      side: 'income' as const,
      on: r.spent_on,
      // ★ 同上：跟支出那一筆對得起來（2026-09-09 使用者:「收入 也叫 人事費 房源」）
      item_name: `人事費 ${estateName(r.estate_id!) || ''}`.trim(),
      amount: r.amount,
      account_code: CODE_LABOR_REV,
      property_id: null,
      office: true,
      payer: estateName(r.estate_id!),
    }));
}

/**
 * 劉姐的工資 —— **安幸辦公室的支出**，不是物業的。
 *
 * ★★★ 這是跟上一版最大的差別。以前記在房源上、付款方式匯款 8088,
 *   等於把她的薪水算成那間房的成本 —— 而物業已經付過那間房的清潔費了,
 *   同一份工被記了兩次成本。
 *
 * ★ 房號留在項目名稱裡（`劉姐 2.5 小時 × $500・14B3`）——
 *   金額歸安幸，但「這筆工資花在哪幾間」查得到。
 */
export function hourlyExpense(
  hrRows: {
    key: string; spent_on: string; staff_name: string;
    hours: number; rate: number; amount: number; share: number;
  }[],
  roomName: (propertyId: string) => string,
  rooms: { key: string; property_id: string }[],
): HkEntry[] {
  const roomOf = new Map(rooms.map((r) => [r.key, r.property_id]));
  return (hrRows ?? []).map((r) => {
    const pid = roomOf.get(r.key);
    const room = pid ? roomName(pid) : '';
    const per = r.share > 1 ? r.hours / r.share : r.hours;
    return {
      key: r.key,                       // 沿用 hourlyRows 的 `HR|…`
      side: 'expense' as const,
      on: r.spent_on,
      item_name: `${r.staff_name} ${round1(per)} 小時 × $${r.rate.toLocaleString('en-US')}`
        + (room ? `・${room}` : ''),
      amount: r.amount,
      account_code: CODE_SALARY,
      property_id: null,
      office: true,
    };
  });
}

/** 3 → 「3」、2.5 → 「2.5」。時數常常是半小時。 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 預覽用的合計。收入與支出**分開加** —— 加在一起是沒有意義的數字。 */
export function sideTotal(rows: HkEntry[], side: EntrySide): number {
  return (rows ?? []).filter((r) => r.side === side)
    .reduce((a, r) => a + (Number(r.amount) || 0), 0);
}
