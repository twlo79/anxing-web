'use client';
import { ReactNode } from 'react';

/**
 * 「一列一個項目 ＋ 長條 ＋ 數字」的分項面板。**全站唯一一份。**
 *
 * ============================================================
 * 【為什麼要有這支】（2026-08-29 使用者：「全版面 都優化一致標準」）
 *
 * 這種面板在七個地方各寫了一份，而且沒有兩份長得一樣：
 *
 * | | 卡片 | 標題 | 列 | 長條 | 名稱欄 |
 * |---|---|---|---|---|---|
 * | 支出 ×3 | `glass p-4` | `text-sm` 無底線 | `space-y-1.5` `text-xs` | `h-2 rounded` | `w-20` |
 * | 清潔 | 白卡 ＋ 標題列 | `text-sm font-semibold` | `py-2` `text-sm` | `h-1.5 rounded-full` | `w-16` |
 * | 收入 | 同上 | 同上 | 同上 | 同上 | `w-16` |
 * | 評價 ×2 | 同上 | 同上 | 同上 | 同上 | `w-14` |
 * | 短租 | 同上 | 同上 | 沒有長條 | — | 自由寬 |
 *
 * 四種名稱欄寬、兩種長條、兩種字級、兩種卡片。單看一頁都合理，
 * 兩頁擺在一起就看得出來其中一頁的字比較小。
 *
 * ★ 收斂到**多數派**（白卡 ＋ 標題列那一種，四頁在用），
 *   支出頁那三張 glass 卡是少數派，改過來。
 *
 * ============================================================
 * 【★★★ 三條不能退回去的規矩】
 *
 * 1. **列的字是 `text-sm`（15px），不是 `text-xs`。**
 *    支出頁原本用 13px —— 那是表格裡塞十二欄時才需要的尺寸，
 *    這種一列只有三個東西的面板沒有理由跟著縮。
 *
 * 2. **不捲。** 原本 `max-h-44 overflow-auto` 一次只露四列，
 *    而這種面板的用途正是「一眼看完分布」——
 *    捲軸把它變成「一次看四項，其餘要用滑鼠找」。
 *    卡片長一點沒關係，捲軸裡的東西等於不存在。
 *
 * 3. **名字不夠寬就換行，不要截斷。**
 *    帳戶叫「(安幸)元大 20992…」，四個帳戶共用前六個字 ——
 *    `truncate` 砍掉的正好是唯一分得出來的那一段，
 *    畫面上會出現三列一模一樣的「(安幸)元大 2…」。
 *    這跟 `splitTail` 要留末五碼是同一條道理：**差異在尾巴。**
 */

export type BarTone = 'blue' | 'green' | 'slate';

const FILL: Record<BarTone, string> = {
  blue: 'bg-mor-blue',
  green: 'bg-mor-green',
  slate: 'bg-mor-slate',
};

/**
 * 面板外框。標題列用 `text-ui`（17px）—— 它是**外框**不是資料，
 * 跟按鈕、篩選標題同一級（見 anxing-ui skill 的字級表）。
 */
export function BarPanel({ title, right, children, className = '' }: {
  title: ReactNode;
  /** 標題列右邊（下載鈕之類）。沒有就不佔位置。 */
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl bg-white border border-mor-line overflow-hidden min-w-0 ${className}`}>
      <div className="flex items-center justify-between gap-2 border-b border-mor-line bg-white/45 px-4 py-2.5">
        <span className="text-ui font-semibold">{title}</span>
        {right}
      </div>
      {/* ★ 這裡**沒有** max-h / overflow —— 見上面第 2 條 */}
      <div>{children}</div>
    </div>
  );
}

/**
 * 一列。
 *
 * @param pct   長條佔滿的百分比（0–100）。已經是 0 的項目也給 2%，
 *              不然那一列看起來像壞掉而不是「金額很小」。
 * @param label 項目名稱。**會換行不會截斷**，最多兩行。
 * @param value 右邊的主要數字。
 * @param note  再右邊的附註（「128 筆」）。沒有就不佔位置。
 */
export function BarRow({
  label, title, pct, tone = 'blue', value, note, onClick, active = false,
}: {
  label: ReactNode;
  /** 滑鼠停留時的完整文字。名稱換行後仍可能被 line-clamp 切到第三行。 */
  title?: string;
  pct: number;
  tone?: BarTone;
  value: ReactNode;
  note?: ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  const inner = (
    <>
      {/*
        ★★ 名稱欄 `w-28`（112px）——原本四個地方是 w-14/w-16/w-20（56–80px）。
          中文 15px 一個字約 15px，112px 放得下七個字，
          而物業名稱（「安幸辦公室」）與科目名稱（「薪資勞務」）都在七個字內。

        ★ `break-words` ＋ `line-clamp-2`：放不下就換第二行，不是切掉尾巴。
          `leading-snug` 讓兩行的高度不會把整列撐開太多。
      */}
      <span className="w-28 shrink-0 break-words leading-snug line-clamp-2 text-left" title={title}>
        {label}
      </span>
      {/*
        ★ 長條 `min-w-[2.5rem]`：名稱換行、金額七位數時 flex-1 會被壓到接近 0，
          而一條寬度 3px 的長條**看起來像沒有資料**。給它一個地板。
      */}
      <span className="flex-1 min-w-[2.5rem] h-2 rounded-full bg-mor-sand overflow-hidden">
        <span className={`block h-full rounded-full ${FILL[tone]}`}
          style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      </span>
      <span className="shrink-0 whitespace-nowrap text-right font-semibold tabular-nums">{value}</span>
      {note && (
        <span className="shrink-0 whitespace-nowrap text-right text-xs text-gray-400 tabular-nums">{note}</span>
      )}
    </>
  );

  const cls = `w-full px-4 py-2 flex items-center gap-3 text-sm text-left
               border-b border-mor-line/50 last:border-0
               ${active ? 'bg-mor-bluelight/60' : ''}
               ${onClick ? 'cursor-pointer hover:bg-mor-bluelight/40' : ''}`;

  /*
   * ★★ 可以點的做成 `<button>`，不可以點的做成 `<div>`。
   *   全部做成 div 加 onClick 的話，鍵盤走不到、讀螢幕也不會說那是可按的。
   */
  return onClick
    ? <button type="button" onClick={onClick} className={cls}>{inner}</button>
    : <div className={cls}>{inner}</div>;
}

/** 沒有資料時的那一列。**要有一列**，不要整塊空白 —— 空白看起來像還在載入。 */
export function BarEmpty({ children = '無資料' }: { children?: ReactNode }) {
  return <div className="px-4 py-3 text-sm text-gray-400">{children}</div>;
}
