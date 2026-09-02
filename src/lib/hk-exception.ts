/**
 * 房務例外清單能做的三件事：重新解析、手動加入、按掉。
 *
 * ============================================================
 * 【★★★ 為什麼「重新解析」有存在的必要】（2026-09-01 發現）
 *
 * `hk_event.parsed_code` 是**匯入當下算好存進去的**
 * （`import-panel.tsx` 與 `api/import/housekeeping/route.ts` 都是
 *   `parsed_code: e.propertyCode`），不是每次讀取時重算。
 *
 * 所以後來才補的別名**不會回頭修既有資料**:
 *
 *   2026-08 匯入「退-J1-Chung Hoon」→ 那時沒有 J1 這個別名 → parsed_code = null
 *   2026-08-31 migration_190 加了 J1 → JPR1F
 *   → 那筆還是 null，永遠躺在例外清單裡
 *
 * ★★ 症狀是「明明別名加了，例外清單還是一樣長」——
 *   而看的人會以為別名沒生效，跑去再加一次。
 *
 * ★ 修法**不是**讓畫面即時重算（那樣每次開頁都要重跑解析，
 *   而且「當時對到什麼」這個歷史就沒了）。
 *   是給一個明確的動作:按下去、看預覽、確認才寫。
 *
 * ============================================================
 * 【為什麼寫在 `.ts` 而不是頁面裡】
 *
 * 測試執行環境不處理 JSX（見 CLAUDE.md）。而這裡兩件事都是
 * **錯了不會報錯**的類型:
 *
 *   · 重新解析對錯房源 → 某個人的點數算到別人頭上，畫面上看不出來
 *   · 按掉的判斷寫錯   → 一筆真的清掃從統計裡消失，而且沒有痕跡
 */

/** 例外清單上的一列（`hk_event` 的子集）。 */
export type ExEvent = {
  id: string;
  event_date: string;
  title: string;
  assignees: string[];
  parsed_code: string | null;
  work_type: string | null;
  excluded: string | null;
  /** 被按掉的時間。null = 還在清單上（migration_188）。 */
  dismissed_at?: string | null;
  dismissed_by?: string | null;
};

/** 一筆重新解析的建議。 */
export type Reparse = {
  id: string;
  event_date: string;
  title: string;
  /** 重新解析對到的房源代碼。 */
  code: string;
};

export const isDismissed = (e: ExEvent) => !!e.dismissed_at;

/**
 * 用**現在**的房源主檔重新解析，回傳「本來沒對到、現在對得到」的那幾筆。
 *
 * @param match 傳進來而不是 import —— `matchProperty` 需要一個
 *              `buildLookup()` 的結果，那是頁面才有的東西。
 *              測試可以傳一個假的，不用建整份主檔。
 *
 * ★★★ 只回**有改變**的。全部回傳的話，使用者要在一堆「還是 null」
 *   裡面找出那 5 筆有意義的 —— 而預覽的價值就是「只給我要看的」。
 *
 * ★★ 已經按掉的**不重新解析**。按掉是人的決定（「這不是清掃」），
 *   系統不該因為後來多了一個別名就把它翻案。要翻案請先還原。
 */
export function reparsePreview(
  events: ExEvent[],
  match: (title: string) => string | null,
): Reparse[] {
  const out: Reparse[] = [];
  for (const e of events ?? []) {
    if (isDismissed(e)) continue;
    if (e.parsed_code) continue;          // 本來就對到了，不動
    if (e.excluded) continue;             // 休假／未指派不是房源問題
    const code = match(e.title);
    if (!code) continue;                  // 現在還是對不到
    out.push({ id: e.id, event_date: e.event_date, title: e.title, code });
  }
  return out;
}

/**
 * 例外清單要顯示哪幾列。
 *
 * @param showDismissed 打開「顯示已按掉的」時才把它們放回來。
 *
 * ★ 預設藏起來，但**不是刪掉** —— 按掉是「我看過了，這筆不算」，
 *   不是「這筆不存在」。三個月後有人問「八月那筆聚餐怎麼沒進統計」，
 *   要查得到是誰在什麼時候按掉的。
 */
export function visibleRows(events: ExEvent[], showDismissed: boolean): ExEvent[] {
  return (events ?? []).filter((e) => showDismissed || !isDismissed(e));
}

/** 已按掉的筆數。給「顯示已按掉的（N）」那顆用。 */
export const dismissedCount = (events: ExEvent[]) =>
  (events ?? []).filter(isDismissed).length;

/**
 * 「手動加入」表單的預帶值。
 *
 * ★★★ 房源**留空**。標題裡抽不出房源正是這一筆在例外清單的原因 ——
 *   猜一個填進去的話，使用者只要沒注意就會按下加入，
 *   而那筆清掃會算到錯的房源頭上（CLAUDE.md:「對不上的不猜」）。
 *
 * ★ 日期與人員照抄:那兩個是行事曆上寫明的事實，不是推測。
 */
export function prefillFromEvent(
  e: ExEvent,
  staffIdByName: (name: string) => string | null,
): { date: string; code: string; type: string; staffIds: string[] } {
  const ids: string[] = [];
  for (const n of e.assignees ?? []) {
    const id = staffIdByName(n);
    // ★ 對不到的人名直接跳過。硬塞一個最像的會讓工作量算到別人頭上
    if (id && !ids.includes(id)) ids.push(id);
  }
  return {
    date: e.event_date,
    code: '',
    type: e.work_type || '清潔',
    staffIds: ids,
  };
}

/**
 * 這一列能不能按掉。
 *
 * ★★ 只有**事件**能按掉。「尚未建檔幾床」列的是房源，
 *   它的解法是去把床數填上 —— 按掉只會讓少算的床單消失在視線外，
 *   而床單總數依然是錯的。
 */
export const canDismiss = (row: { id?: string } | string): boolean =>
  typeof row !== 'string' && !!row.id;

/**
 * 這一列為什麼沒進統計 —— 給清單上的「原因」欄。
 *
 * ★★★ 原因要**寫在每一列上**，不是分成好幾個區塊各有一個標題。
 *   分區塊的話，同一天的兩筆會落在畫面上相距很遠的地方，
 *   而使用者是照日期在找東西的（2026-08-31 使用者:
 *   「我看不懂耶 我的理解是 1. 看甚麼沒進系統 2. 手動放進去 3. 手動記入 按掉」）。
 *
 * ★ 回傳的是**現象**不是指令 —— 「房源沒對到」而不是「請去設定加別名」。
 *   要做什麼由旁邊那兩顆按鈕回答。
 */
export function reasonOf(e: ExEvent): string {
  if (e.excluded === 'no_assignee') return '人員對不到';
  if (!e.parsed_code) return '房源沒對到';
  return '未計入';
}

/**
 * 例外清單要顯示的事件 —— **未指派與房源對不到合成一份**。
 *
 * ★★ 原本是兩個獨立的區塊。合起來是因為使用者要的是
 *   「這個月有哪幾筆沒進系統」這一個問題的答案，
 *   而不是「沒進系統的原因有幾種」。
 *
 * ★ 協助行政／洗烘折毛巾本來就不是房源工作，不列 —— 那不是例外，是常態。
 */
const NOT_EXCEPTION = ['協助行政', '洗烘折毛巾'];

export function exceptionEvents(events: ExEvent[]): ExEvent[] {
  return (events ?? []).filter((e) => {
    if (NOT_EXCEPTION.some((k) => e.title.includes(k))) return false;
    if (e.excluded === 'no_assignee') return true;
    return !e.excluded && !e.parsed_code;
  });
}
