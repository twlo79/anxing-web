'use client';
/**
 * 表頭排序共用元件 — 短租 / 契約 / 營收三頁共用。
 *
 * 只提供「表頭 UI + 排序狀態」,不強制排序怎麼執行:
 *   - 契約頁、營收頁:前端排序,用 sortRows()
 *   - 短租頁:伺服器端排序(Supabase .order()),用 state.key 對映欄位名
 * 因為短租頁是伺服器端分頁,若改成前端排序只會排到當前頁的 100 筆,結果是錯的。
 */
import { ReactNode } from 'react';

export type SortDir = 'asc' | 'desc';
export type SortState = { key: string; dir: SortDir } | null;

/** 欄位型別,決定比較方式與提示文字 */
export type SortType = 'text' | 'number' | 'date' | 'room';

const HINT: Record<SortType, [string, string]> = {
  text: ['從 A 到 Z 排序', '從 Z 到 A 排序'],
  number: ['從最小到最大排序', '從最大到最小排序'],
  date: ['從最舊到最新排序', '從最新到最舊排序'],
  room: ['房號從小到大排序', '房號從大到小排序'],
};

/**
 * 房號自然排序:先比開頭數字,再比其餘字串。
 * 純字串比較會讓 13B1 排在 3A5 前面,與實際樓層順序不符。
 */
export function roomKey(x: unknown): [number, string] {
  const s = String(x ?? '');
  const m = s.match(/^(\d+)/);
  return [m ? parseInt(m[1]) : 999999, s];
}

function cmp(a: unknown, b: unknown, type: SortType): number {
  if (type === 'room') {
    const ka = roomKey(a), kb = roomKey(b);
    return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0);
  }
  if (type === 'number') {
    const na = Number(a ?? 0), nb = Number(b ?? 0);
    return (isNaN(na) ? 0 : na) - (isNaN(nb) ? 0 : nb);
  }
  // date 與 text 都用字串比較(日期為 YYYY-MM-DD,字典序即時間序)
  const sa = String(a ?? ''), sb = String(b ?? '');
  // 空值一律排最後,不論升降冪 —— 否則降冪時整片空白會浮到最上面
  if (!sa && !sb) return 0;
  if (!sa) return 1;
  if (!sb) return -1;
  return sa.localeCompare(sb, 'zh-Hant');
}

/** 欄位定義:key → 型別與取值方式 */
export type SortCols<T> = Record<string, { type: SortType; get: (r: T) => unknown }>;

/** 前端排序。state 為 null 時原樣回傳(保留呼叫端的預設順序)。 */
export function sortRows<T>(rows: T[], state: SortState, cols: SortCols<T>): T[] {
  if (!state) return rows;
  const col = cols[state.key];
  if (!col) return rows;
  const sign = state.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const r = cmp(col.get(a), col.get(b), col.type);
    // 空值永遠殿後,所以不隨 sign 反轉
    if (r === 1 && !String(col.get(a) ?? '')) return 1;
    if (r === -1 && !String(col.get(b) ?? '')) return -1;
    return r * sign;
  });
}

/**
 * 可排序表頭。上下箭頭各自獨立 —— 點 ▲ 直接升冪、點 ▼ 直接降冪,
 * 不是點一下切換一次,想要哪個方向就點哪個。
 */
export function SortTh({
  label, sortKey, type = 'text', state, onSort, className = '', align = 'left',
}: {
  label: ReactNode;
  sortKey: string;
  type?: SortType;
  state: SortState;
  onSort: (key: string, dir: SortDir) => void;
  className?: string;
  align?: 'left' | 'right';
}) {
  const activeAsc = state?.key === sortKey && state.dir === 'asc';
  const activeDesc = state?.key === sortKey && state.dir === 'desc';
  const [hintAsc, hintDesc] = HINT[type];
  // 箭頭原本是 9px + text-gray-300,又小又淡,幾乎看不出可以點。
  // 改用 SVG 三角形而非 ▲▼ 字元 —— 字元的實際大小取決於字型,
  // 各作業系統/瀏覽器算出來的尺寸不一致,SVG 才控制得住。
  const arrow = (dir: SortDir, on: boolean, hint: string) => (
    <button
      type="button"
      onClick={() => onSort(sortKey, dir)}
      title={hint}
      aria-label={hint}
      className={`flex items-center justify-center w-4 h-3 rounded transition-colors ${
        on ? 'text-mor-blue' : 'text-gray-400 hover:text-mor-slate hover:bg-mor-sand/70'
      }`}
    >
      <svg viewBox="0 0 10 6" className="w-2.5 h-1.5" fill="currentColor" aria-hidden="true">
        {dir === 'asc' ? <path d="M5 0 L10 6 L0 6 Z" /> : <path d="M5 6 L10 0 L0 0 Z" />}
      </svg>
    </button>
  );
  return (
    <th className={`px-3 py-2.5 ${className}`}>
      <span className={`inline-flex items-center gap-1.5 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        <span className="whitespace-nowrap">{label}</span>
        <span className="inline-flex flex-col shrink-0 gap-px">
          {arrow('asc', activeAsc, hintAsc)}
          {arrow('desc', activeDesc, hintDesc)}
        </span>
      </span>
    </th>
  );
}
