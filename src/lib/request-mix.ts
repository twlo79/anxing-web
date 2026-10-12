/**
 * 出勤「申請」頁的審核與狀態：**三種單混在同一張清單**（2026-10-12 David 選 A）。
 *
 *   「審核、狀態是不是整合一起，分三段就好；只有申請要分三種」
 *
 * 以前是先選種類（請假／加班／補登）再選階段 —— 紅點寫 13，點進「審核」
 * 只看到請假那幾張，另外幾張要切種類才找得到。
 *
 * ★ 排序看**送出時間**（created_at）：
 *     待審　最舊的在上 —— 放最久的先處理
 *     其他　最新的在上 —— 「我剛送的那張」在最上面
 * ★ 種類藥丸的數字算在**篩選之前** —— 算在之後的話按下去數字就不再變（anxing-ui 四-1）。
 */
export type ReqKind = 'leave' | 'ot' | 'fix';
export const REQ_KINDS: readonly ReqKind[] = ['leave', 'ot', 'fix'];
export const REQ_KIND_LABEL: Record<ReqKind, string> = { leave: '請假', ot: '加班', fix: '補登' };

export type MixItem<T> = { kind: ReqKind; key: string; at: string; row: T };

const ORDER: Record<ReqKind, number> = { leave: 0, ot: 1, fix: 2 };

/** 依送出時間排；同一刻送出的依種類排（請假→加班→補登），再依 key —— 每次畫出來順序都一樣 */
export function mixRequests<X extends { kind: ReqKind; key: string; at: string }>(items: readonly X[], oldestFirst: boolean): X[] {
  const dir = oldestFirst ? 1 : -1;
  return [...items].sort((a, b) =>
    dir * (a.at ?? '').localeCompare(b.at ?? '')
    || ORDER[a.kind] - ORDER[b.kind]
    || a.key.localeCompare(b.key));
}

export function countByKind(items: readonly { kind: ReqKind }[]): Record<ReqKind, number> {
  const n: Record<ReqKind, number> = { leave: 0, ot: 0, fix: 0 };
  for (const x of items) n[x.kind]++;
  return n;
}

/** '' ＝ 不篩 */
export function filterKind<T extends { kind: ReqKind }>(items: readonly T[], f: ReqKind | ''): T[] {
  return f ? items.filter((x) => x.kind === f) : [...items];
}

/** 空清單的那一句 */
export function emptyText(f: ReqKind | '', what: string): string {
  return `${what}${f ? REQ_KIND_LABEL[f] : '單'}`;
}
