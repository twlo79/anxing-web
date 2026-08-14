/**
 * 把貼進來的東西變成一筆一筆的排班。
 *
 * ============================================================
 * 【為什麼不能只靠換行】
 *
 * 實際貼進去的長這樣（換行全部沒了，變成一整條）：
 *
 *     2026-08-01,退-開4-Nga Ki,SHAO-YING HSIEH 2026-08-01,B5-吳瑋茹-入住,月(Dianne) …
 *
 * 用 `split('\n')` 的結果是**一筆**，而且那一筆的「負責人」欄
 * 是後面整個月的內容 —— 預覽顯示「共 1 筆、未知人員 SHAO-YING HSIEH」，
 * 看起來像是人員主檔的問題，其實是解析從第一步就散了。
 *
 * 換行會不會活著取決於剪貼簿、來源程式、作業系統。那不是使用者能控制的，
 * 也不該是他要理解的東西。
 *
 * 每一筆都以 `YYYY-MM-DD,` 開頭，這是資料本身的結構，比換行可靠。
 * 所以**看到日期就切一刀**，換行有沒有活著都一樣。
 *
 *
 * ============================================================
 * 【沒有負責人的那一筆】
 *
 *     …,退-JPR整棟-Conrad Chan,2026-08-18,U休,…
 *                             ↑ 下一筆直接接在逗號後面
 *
 * 那天是真的沒排人。切完把頭尾的逗號去掉，負責人就是空的 ——
 * 預覽會算進「未指派」，那正是要被看見的東西。
 */

export type RawRow = { date: string; title: string; assignees: string };

const DATE = /\d{4}-\d{2}-\d{2}/;

/**
 * 支援三種貼法：
 *   1. 一行一筆（正常）
 *   2. 換行掉光的一整條
 *   3. 排程抓下來的 JSON（`{records:[…]}` 或直接一個陣列）
 */
export function splitRecords(raw: string): RawRow[] {
  const t = (raw ?? '').trim();
  if (!t) return [];

  // JSON 優先。他手上就有排程抓下來的檔案，何必先轉成文字再貼
  if (t[0] === '{' || t[0] === '[') {
    const j = tryJson(t);
    if (j) return j;
    // 解不出來就往下當文字處理 —— 不要在這裡丟錯，
    // 貼錯東西的人需要的是「看到 0 筆」，不是一個紅色例外
  }

  /*
   * 以「日期＋逗號」為界切開。
   * 用 lookahead 是為了把日期留在後半段 —— split 掉的話第一個欄位就沒了。
   *
   * 要求日期後面接逗號：標題裡的「(8/2)」「8/3下午一點已退」不是這個格式，
   * 不會誤切。
   */
  return t.split(/(?=\d{4}-\d{2}-\d{2},)/)
    .map((chunk) => chunk.trim().replace(/^[,\s]+|[,\s]+$/g, ''))
    .filter(Boolean)
    .map(toRow)
    .filter((r): r is RawRow => r !== null);
}

function toRow(chunk: string): RawRow | null {
  const parts = chunk.split(/[,\t]/).map((x) => x.trim());
  if (!DATE.test(parts[0] ?? '')) return null;
  return {
    date: parts[0],
    title: parts[1] ?? '',
    // 標題以外全部算負責人。標題裡有逗號的話會被吃掉一段 ——
    // 但那比「負責人被截斷」好：少了人就沒人被指派，看得出來
    assignees: parts.slice(2).join(','),
  };
}

function tryJson(t: string): RawRow[] | null {
  try {
    const j = JSON.parse(t);
    const arr: unknown[] = Array.isArray(j) ? j : (j?.records ?? []);
    if (!Array.isArray(arr)) return null;
    const out = arr.map((x) => {
      const r = x as { date?: string; title?: string; assignees?: unknown };
      if (!r?.date || !DATE.test(r.date)) return null;
      return {
        date: r.date,
        title: r.title ?? '',
        // 排程存的是陣列，貼進來的文字是字串 —— 兩種都收
        assignees: Array.isArray(r.assignees)
          ? r.assignees.join('、')
          : String(r.assignees ?? ''),
      };
    }).filter((x): x is RawRow => x !== null);
    return out.length ? out : null;
  } catch {
    return null;
  }
}
