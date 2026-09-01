/**
 * 寵物押金與寵物費：哪些選項出得來、金額帶多少、鎖不鎖。
 *
 * ============================================================
 * 【為什麼寫在 `.ts` 而不是頁面裡】
 *
 * 測試執行環境不處理 JSX（見 CLAUDE.md）—— 寫在 `.tsx` 裡的判斷式測不到。
 * 而這裡三件事全都是**錯了不會報錯**的類型:
 *
 *   · 開封的下拉裡冒出「寵物押金」→ 收了一筆不該收的錢
 *   · 金額帶錯物業        → 數字看起來很正常，只是收錯了
 *   · 該鎖的沒鎖          → 使用者不小心改掉，而畫面不會說
 *
 * ============================================================
 * 【★★★ 三種狀態，不是兩種】（migration_193）
 *
 *     禁止        pet_allowed = false        下拉裡**沒有**寵物那一項
 *     未設定      沒有列，或金額是 null      有選項，但不帶入、不上鎖
 *     有預設      金額有值                   帶入並上鎖
 *
 * ★★ 「禁止」跟「金額 0」在資料庫裡長得完全不同，在畫面上的行為也相反 ——
 *   前者連選項都不該出現，後者是「可以帶，這次不收」。
 *   用一個數字兼表兩種意思，是「以後每次都要多想一次」的來源。
 *
 * ★★★ 「未設定」（台視、復興）**不擋** —— 出選項，但不猜金額。
 *   擋住的話，真的有人帶寵物來時系統裡記不了這筆錢，
 *   而使用者會找一個最像的欄位塞進去（然後報表上就看不見了）。
 *   CLAUDE.md：「少填一個看得到、補得回來；填錯一個沒有人會發現。」
 */

/** `estate_fee_default` 的一列。 */
export type FeeDefault = {
  estate_id: string;
  pet_allowed: boolean;
  pet_deposit: number | null;
  pet_fee: number | null;
};

/** 押金項目。null 代表舊資料，顯示成「一般押金」但**不回填**（migration_193）。 */
export const DEPOSIT_ITEMS = ['一般押金', '寵物押金'] as const;
export type DepositItem = (typeof DEPOSIT_ITEMS)[number];

/** 加費選單裡的寵物費 label。跟 `ONEOFF_PRESETS` 的那一筆一致。 */
export const PET_FEE_LABEL = '寵物費';

/*
 * ★★★ `null` 與 `undefined` 要**先擋掉**，不能只靠 `Number.isFinite`。
 *
 *   Number(null)  === 0   而 Number.isFinite(0) 是 true
 *   Number('')    === 0   同上
 *
 * 少了前兩行，「未設定」的物業會回 0 —— 而 0 會被 `startsLocked` 當成
 * 一個真的預設值，於是畫面上出現「金額 0、而且鎖住」。
 * 使用者看到的是一個被鎖起來的錯誤答案。
 *
 * ★ 這一行是測試抓出來的（2026-09-01），不是想出來的。
 */
const num = (n: unknown): number | null => {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
};

/**
 * 從清單裡找出這個物業的設定。找不到回 null —— **不要退而用別的物業**。
 *
 * ★ 退一步用「第一筆」或「最像的」會讓開封拿到時兆的金額，
 *   而那在畫面上完全看不出來:數字是合理的，只是收錯了。
 */
export function defaultOf(list: FeeDefault[], estateId: string | null | undefined): FeeDefault | null {
  if (!estateId) return null;
  return (list ?? []).find((d) => d && d.estate_id === estateId) ?? null;
}

/**
 * 這個物業可不可以帶寵物。
 *
 * ★★ **沒有設定時回 true**（見檔頭第三段）—— 未知不等於禁止。
 *   只有明確寫了 `pet_allowed = false` 才擋。
 */
export function petAllowed(list: FeeDefault[], estateId: string | null | undefined): boolean {
  const d = defaultOf(list, estateId);
  return d ? d.pet_allowed : true;
}

/**
 * 押金項目的下拉選項。
 *
 * 「一般押金」永遠在，而且永遠排第一 —— 它是最常用的那一種。
 */
export function depositItems(list: FeeDefault[], estateId: string | null | undefined): DepositItem[] {
  return petAllowed(list, estateId) ? ['一般押金', '寵物押金'] : ['一般押金'];
}

/**
 * 加費選單。禁止帶寵物的物業把「寵物費」拿掉，其餘原封不動。
 *
 * @param presets `ONEOFF_PRESETS`（傳進來而不是 import，這樣測試不用碰那份大清單）
 *
 * ★ 回傳新陣列，不改傳進來的 —— 那份清單是模組層級的常數，
 *   就地改掉的話下一個物業會拿到被過濾過的版本。
 */
export function feePresets<T extends { label: string }>(
  presets: T[], list: FeeDefault[], estateId: string | null | undefined,
): T[] {
  if (petAllowed(list, estateId)) return [...(presets ?? [])];
  return (presets ?? []).filter((p) => p.label !== PET_FEE_LABEL);
}

/**
 * 選了這個項目時要自動帶入的金額。
 *
 * 回 null = **不要動使用者已經打的東西**。三種情況都回 null:
 * 一般押金（本來就沒有預設）、物業沒設定、禁止帶寵物。
 *
 * ★ 回 0 而不是 null 的話，使用者選了「寵物押金」金額會被清成 0，
 *   而 0 看起來像一個決定 —— 那是這支最容易寫錯的一行。
 */
export function autoDepositAmount(
  list: FeeDefault[], estateId: string | null | undefined, item: string | null,
): number | null {
  if (item !== '寵物押金') return null;
  const d = defaultOf(list, estateId);
  if (!d || !d.pet_allowed) return null;
  return num(d.pet_deposit);
}

/** 加費選了「寵物費」時要帶入的金額。規則與 `autoDepositAmount` 相同。 */
export function autoFeeAmount(
  list: FeeDefault[], estateId: string | null | undefined, label: string | null,
): number | null {
  if (label !== PET_FEE_LABEL) return null;
  const d = defaultOf(list, estateId);
  if (!d || !d.pet_allowed) return null;
  return num(d.pet_fee);
}

/**
 * 金額欄要不要一開始就上鎖。
 *
 * ★★★ **有預設值才鎖**（2026-09-01 設計時定的）——
 *   鎖是為了保護一個「已知正確」的數字不被誤改。
 *   沒有預設可保護時還鎖著，只是逼使用者多按一下，
 *   而那一下不會讓任何數字變得更正確。
 */
export function startsLocked(auto: number | null): boolean {
  return auto !== null;
}

/**
 * 使用者改了項目之後，金額欄該變成什麼。
 *
 * 回傳 `{ amount, locked }` —— 兩件事一起決定，因為它們一定同時變。
 * 分成兩個函式各自呼叫的話，總有一天有一處只更新了其中一個。
 *
 * @param current 目前欄位裡的金額。沒有預設時原封不動帶回去。
 */
export function onItemChange(
  list: FeeDefault[], estateId: string | null | undefined,
  item: string | null, current: number,
): { amount: number; locked: boolean } {
  const auto = autoDepositAmount(list, estateId, item);
  return auto === null
    ? { amount: current, locked: false }
    : { amount: auto, locked: true };
}

/** 加費版本的 `onItemChange`。 */
export function onFeeLabelChange(
  list: FeeDefault[], estateId: string | null | undefined,
  label: string | null, current: number,
): { amount: number; locked: boolean } {
  const auto = autoFeeAmount(list, estateId, label);
  return auto === null
    ? { amount: current, locked: false }
    : { amount: auto, locked: true };
}

/**
 * 存檔前的檢查。回傳錯誤訊息，沒問題回 null。
 *
 * ★★★ 這是**最後一道**。畫面上已經把寵物那兩項從下拉裡拿掉了，
 *   但下拉不是唯一的入口 —— 改別的欄位、切換房源、貼上舊資料
 *   都可能讓一筆「開封 ＋ 寵物押金」走到這裡。
 *   而它一旦存進去，之後只會看到一個金額合理的押金。
 */
export function validatePetLines(
  list: FeeDefault[], estateId: string | null | undefined,
  items: (string | null)[], feeLabels: (string | null)[] = [],
): string | null {
  if (petAllowed(list, estateId)) return null;
  if ((items ?? []).some((i) => i === '寵物押金')) return '這個物業禁止帶寵物入住，不能收寵物押金';
  if ((feeLabels ?? []).some((l) => l === PET_FEE_LABEL)) return '這個物業禁止帶寵物入住，不能收寵物費';
  return null;
}

/** 顯示用：null 的舊資料一律當成「一般押金」，但不寫回資料庫。 */
export const itemLabel = (item: string | null | undefined): string => item || '一般押金';
