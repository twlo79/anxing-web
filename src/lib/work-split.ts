/**
 * 一份工拆成多間的支出（純函式）。
 *
 * ============================================================
 * 【這是什麼】（2026-09-03 使用者:「我想要在表單上呈現一項 然後支出拆成多間」）
 *
 * 庭玉 08-14 在正隆掃了 4B3、13A5、14B1 三間，工作量算一半。
 * 排班表上是**一格**:代碼「正隆多間」、間數 0.5。
 * 但那筆錢要記到三個房源頭上，各 1,500。
 *
 *   工單（排班表看到的）   一筆    正隆多間・0.5 間
 *   支出（帳上看到的）     三筆    4B3 $1,500、13A5 $1,500、14B1 $1,500
 *
 * ★★★ **拆的是錢，不是工作量。**
 *   打掃量、報酬點數、床單全部走原本那一筆（0.5 間、床單手填）。
 *   動到那些的話就變成同一份工在兩個地方各算一次，
 *   而總額只會看起來「比較大」—— 沒有任何地方會叫。
 *
 * ============================================================
 * 【★★★ 為什麼冪等鍵是拆帳列的 uuid】
 *
 * 一般工單的鍵是「日期│房源│工作類型」。拆帳列**不能照抄**:
 * 同一天同一間如果另外還有一份正常工單，兩邊會組出同一個鍵 ——
 * 而 `expenses.hk_job_key` 有唯一索引，第二筆會被**安靜地跳過**。
 * 症狀是帳上少一筆，而畫面上一切正常。
 *
 * 所以拆帳列用自己的 uuid:`split:<id>`。uuid 不會跟任何東西撞，
 * 而且拆帳列改金額時 id 不變 —— 認得出那是同一筆。
 *
 * ★ 代價:拆帳列被刪掉時，已經產生的那筆支出變孤兒。
 *   它不會自己消失（錢付了就是付了），要靠孤兒清單看得到。
 *
 * ============================================================
 * 【★ 為什麼不用 hk_work_item.id 當外鍵】
 *
 * 兩個人合掃是**兩列** `hk_work_item`，而那是同一份工。
 * 綁到其中一列的話，那個人被改掉／那列被重新匯入時拆帳就不見了，
 * 而另一列還在 —— 畫面上看起來只是「錢突然少了」。
 *
 * 所以綁的是**工的身分**（日期＋代碼＋工作類型），跟 `estateLog` 合併的依據一致。
 */

/** 一列拆帳。`amount` 是這一間分到多少錢。 */
export type SplitLine = {
  id: string;
  work_date: string;
  /** 工單上的房務代碼（`hk_work_item.property_code`），例如「正隆多間」 */
  job_code: string;
  work_type: string;
  /** 這一列記到哪個 ERP 房源 —— 必填，這是拆帳的整個重點 */
  property_id: string;
  amount: number;
  /** 房源字樣，給項目名稱用。★ 由畫面填，lib 不查主檔 */
  property_label?: string | null;
};

/**
 * 一份工的身分。
 *
 * ★★ 跟 `estateLog` 的合併依據一致（日期＋房源字樣＋工作類型）——
 *   兩邊不一致的話，拆帳會對不到那份工而**安靜地不生效**。
 * ★ 用 `label`（代碼字樣）不是 `property_id`:會需要拆帳的那些工
 *   正是**沒有** property_id 的（「正隆多間」不在主檔裡）。
 */
export const splitJobKey = (j: {
  work_date: string; label?: string | null; work_type: string;
}) => `${j.work_date}|${j.label ?? ''}|${j.work_type}`;

/** 同一列拆帳的 key（存進資料庫的那三個欄位算出來的） */
export const splitLineJobKey = (s: SplitLine) =>
  `${s.work_date}|${s.job_code}|${s.work_type}`;

/** 支出的冪等鍵。★ 前綴讓它永遠不會跟一般工單的鍵撞。 */
export const splitExpenseKey = (id: string) => `split:${id}`;

/** 這個鍵是不是拆帳來的 —— 孤兒偵測與畫面分辨都用它 */
export const isSplitKey = (key: string | null | undefined) =>
  typeof key === 'string' && key.startsWith('split:');

/** 從支出的鍵取回拆帳列的 id */
export const splitIdOf = (key: string) =>
  isSplitKey(key) ? key.slice('split:'.length) : null;

/**
 * 照「哪一份工」分組。
 *
 * ★ 回 Map 不是陣列 —— `cleaningCosts` 每一份工都要查一次，
 *   線性掃的話 74 間 × 一個月就是幾千次比對。
 */
export function indexSplits(lines: SplitLine[]): Map<string, SplitLine[]> {
  const out = new Map<string, SplitLine[]>();
  for (const s of lines ?? []) {
    const k = splitLineJobKey(s);
    const list = out.get(k) ?? [];
    list.push(s);
    out.set(k, list);
  }
  return out;
}

/** 這幾列合計多少錢。畫面上要看得到 —— 拆完對不對就看這個數字。 */
export const splitTotal = (lines: { amount: number }[]) =>
  (lines ?? []).reduce((a, s) => a + (Number(s.amount) || 0), 0);

/**
 * 這幾列能不能存。回錯誤字串，`null` = 可以。
 *
 * ★★★ 同一份工不能拆到同一間兩次 —— 資料庫有唯一索引擋著，
 *   但撞上去的訊息是 `duplicate key value violates unique constraint`，
 *   而使用者看到那句話只會覺得系統壞了。這裡先講人話。
 *
 * ★ 不檢查合計等於多少。正隆多間**沒有單價可查**（它不在房源主檔），
 *   所以沒有一個「應該是多少」可以比對（2026-09-03 使用者決定不擋）。
 */
export function splitError(
  lines: { property_id: string | null; amount: number | null }[],
): string | null {
  const ls = lines ?? [];
  if (ls.length === 0) return '至少要拆成一間';

  const seen = new Set<string>();
  for (const l of ls) {
    if (!l.property_id) return '每一列都要選房源';
    if (seen.has(l.property_id)) return '同一間房源只能出現一次';
    seen.add(l.property_id);

    if (l.amount == null) return '每一列都要填金額';
    if (!Number.isFinite(Number(l.amount)) || Number(l.amount) < 0) {
      return '金額只能是 0 以上的數字';
    }
  }
  return null;
}

/** 這份工有沒有被拆過 —— 有的話走拆帳、不走「間數 × 單價」。 */
export const hasSplit = (lines: SplitLine[] | undefined | null) =>
  !!lines && lines.length > 0;

/**
 * 孤兒:已經產生的拆帳支出，而它那一列拆帳已經不在了。
 *
 * ★★ 支出**不會**跟著刪 —— 錢付了就是付了，不該因為改了拆法
 *   而從帳上消失。所以要列出來讓人決定（CLAUDE.md:「建議，不自動」）。
 *
 * @param expenseKeys 已經產生過的 `expenses.hk_job_key`
 * @param lines       現在還在的拆帳列
 */
export function orphanSplitKeys(
  expenseKeys: (string | null | undefined)[],
  lines: SplitLine[],
): string[] {
  const alive = new Set((lines ?? []).map((s) => splitExpenseKey(s.id)));
  const out: string[] = [];
  for (const k of expenseKeys ?? []) {
    if (!isSplitKey(k)) continue;
    if (!alive.has(k as string)) out.push(k as string);
  }
  return out;
}
