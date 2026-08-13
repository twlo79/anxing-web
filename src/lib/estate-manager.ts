/**
 * 管家任期（純函式）。
 *
 * ============================================================
 * 【為什麼需要這一層】
 *
 * 「誰負責哪個物業」原本是 estates.manager 一個文字欄位 —— 沒有時間。
 * 管家輪動之後把那格改掉，**過去所有評價的歸屬就跟著一起變**：
 * 新接手的人一上任就背著前任的分數，離開的人的貢獻憑空消失，
 * 而且沒有任何跡象顯示這件事發生過。
 *
 * 改成一段一段的任期之後，歷史就固定了 —— 拿評價的**退房日**
 * 回去查那天是誰在管，答案永遠一樣。
 *
 * 資料表與 SQL 端的規則在 migration_115；這裡是給畫面用的同一套邏輯。
 */

export type Tenure = {
  id: string;
  estate_id: string;
  staff_id: string;
  /** 這一段的第一天 */
  start_date: string;
  /** 這一段的最後一天。null = 至今 */
  end_date: string | null;
};

/** 這一段有沒有涵蓋那一天。含頭含尾 —— end_date 是「他還在管的最後一天」。 */
export function covers(t: Tenure, on: string): boolean {
  if (on < t.start_date) return false;
  return t.end_date == null || on <= t.end_date;
}

/**
 * 那一天誰在管這個物業。查不到回 null。
 *
 * 【為什麼查不到要回 null 而不是「現任的那位」】
 * 退回現任等於把歷史又算到他頭上 —— 那正是這整件事要解決的問題。
 * 回 null 讓那些評價落在「未指派」，數字本身就是
 * 「還有這麼多評價沒有歸屬」的提醒。
 */
export function managerIdOn(
  tenures: Tenure[], estateId: string | null, on: string | null,
): string | null {
  if (!estateId || !on) return null;
  const hit = tenures.find((t) => t.estate_id === estateId && covers(t, on));
  return hit?.staff_id ?? null;
}

/**
 * 兩段任期有沒有重疊。
 *
 * 【為什麼交接當天不算重疊】
 * 前一段迄日 6/30、後一段起日 7/1 —— 那是正常交接。
 * 但迄日 6/30、起日 6/30 就是重疊：那天有兩個人在管。
 */
export function overlaps(a: Tenure, b: Tenure): boolean {
  const aEnd = a.end_date ?? '9999-12-31';
  const bEnd = b.end_date ?? '9999-12-31';
  return a.start_date <= bEnd && b.start_date <= aEnd;
}

/**
 * 新增或修改一段任期之前的檢查。
 *
 * @param others 同一個物業的其他任期（不含正在編輯的這一段）
 * @returns 擋下來的原因；沒問題回 null
 */
export function checkTenure(
  draft: { start_date: string; end_date: string | null; staff_id: string },
  others: Tenure[],
): string | null {
  if (!draft.staff_id) return '請選管家';
  if (!draft.start_date) return '請填起日';
  if (draft.end_date && draft.end_date < draft.start_date) {
    return `迄日（${draft.end_date}）早於起日（${draft.start_date}），請確認是不是填反了`;
  }
  const me: Tenure = { id: '', estate_id: '', ...draft };
  const bad = others.find((o) => overlaps(me, o));
  if (bad) {
    return `這段期間已經有人在管（${bad.start_date} ~ ${bad.end_date ?? '至今'}）。`
      + `要接手的話，請先把前一段的迄日設成接手日的前一天。`;
  }
  return null;
}

/**
 * 接手：把目前「至今」的那一段結束在 `from` 的前一天。
 *
 * 【為什麼要自動做這件事】
 * 讓使用者自己去改前一段的迄日，他得先算出「接手日減一天」——
 * 而那個減一天正是最容易錯的地方：填成同一天就重疊，
 * 填成兩天前就有一天沒有人管，兩種都不會被發現。
 *
 * @returns 要被結束的那一段與新的迄日；沒有現任就回 null
 */
export function handoverPatch(
  tenures: Tenure[], estateId: string, from: string,
): { id: string; end_date: string } | null {
  const open = tenures.find((t) => t.estate_id === estateId && t.end_date == null);
  if (!open) return null;
  if (from <= open.start_date) return null;   // 比前一段還早，交給 checkTenure 擋
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return { id: open.id, end_date: d.toISOString().slice(0, 10) };
}

/** 顯示用：`2026-01-01 ~ 至今` */
export const tenureLabel = (t: Tenure) =>
  `${t.start_date} ~ ${t.end_date ?? '至今'}`;
