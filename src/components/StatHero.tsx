'use client';
import { ReactNode } from 'react';

/**
 * 深藍大卡 —— 一頁最重要的那個數字。**全站唯一一份。**
 *
 * ============================================================
 * 【為什麼要有這支】（2026-08-29 使用者：「卡片中 文字位置 與 空間配置」）
 *
 * 六頁各寫了一份，而且垂直排法有兩種、附註字級有四種：
 *
 * | | 內容位置 | 標題 | 附註 | 筆數放哪 |
 * |---|---|---|---|---|
 * | 支出 | 置頂 | `text-ui` | `text-uisub` | 右上 |
 * | 訂單 | 置中 | `text-ui` | `text-xs` | 附註那行裡 |
 * | 營收 | 置中 | `text-ui` | `text-xs` | 附註那行裡 |
 * | 清潔 | 置中 | `text-ui` | `text-xs` | 附註那行裡 |
 * | 評價 | 置頂 | `text-ui` | `text-[11px]` | 右上 |
 * | 房務 | 置頂 | `text-ui` | `text-xs` | 沒有 |
 *
 * 四張並排時（支出頁）一張置頂、旁邊三張分項卡的標題列在同一高度，
 * 換到訂單頁又變成置中 —— 同一種卡每一頁的重心都不一樣。
 *
 * ============================================================
 * 【★★★ C 案：標題置頂、數字置中】（使用者從 A／B／C 挑的）
 *
 * ```
 *   認列支出                    128 筆     ← 跟隔壁分項卡的標題列切齊
 *
 *          $9,134,442                     ← 佔住中間，空高度用來把數字放大
 *          全部期間
 * ```
 *
 * ★★ 標題置頂是為了**跟旁邊的卡對齊**；數字置中是為了
 *   卡片被隔壁的分項面板拉高時，中間不會空一大片。
 *   兩件事要分開處理，所以不能整塊 `justify-center`（B 案）
 *   也不能整塊靠上（A 案）。
 *
 * ★★★ 「筆數」一律**右上角**，不要混在附註那一行。
 *   混在一起的話「1,900 筆・押金非營收」是兩件不相干的事黏成一句：
 *   前半是規模、後半是口徑說明。
 */
export default function StatHero({
  title, count, value, sub, children, onClick, hint, className = '',
}: {
  /** 卡片標題。`text-ui`，跟隔壁分項面板的標題同一級。 */
  title: ReactNode;
  /** 右上角的規模（`128 筆`、`共 7 位`）。沒有就不佔位置。 */
  count?: ReactNode;
  /** 中間那個大數字。 */
  value: ReactNode;
  /**
   * 數字底下那一行（期間、口徑說明）。
   *
   * ★★ `text-ui`（17px）＋ `mt-3`（2026-08-29 使用者：
   *   「數字與期間分開一些」「期間字體大一點」）。
   *   原本四頁是 11–13px 又緊貼著數字 —— 比旁邊分項卡的內文還小，
   *   而它講的是「這個數字算的是哪一段」，是讀數字的人第二個要看的東西。
   */
  sub?: ReactNode;
  /** 數字底下再接的東西（評價頁的星等分布）。 */
  children?: ReactNode;
  onClick?: () => void;
  /** 可以點的時候給 `title` 提示。 */
  hint?: string;
  className?: string;
}) {
  const body = (
    <>
      {/*
        ★ 標題列固定在最上面。`items-baseline` 讓 17px 的標題與 15px 的
          筆數對到同一條基線 —— 用 `items-center` 的話兩個字級的中線對齊，
          看起來是筆數浮高了一點點。
      */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ui font-semibold opacity-90">{title}</span>
        {count != null && <span className="text-uisub opacity-80 whitespace-nowrap">{count}</span>}
      </div>
      {/* ★ `flex-1` ＋ `justify-center`：卡片被隔壁拉高時，多出來的高度平均分到數字上下 */}
      <div className="flex-1 flex flex-col justify-center min-w-0">
        <div className="stat-num-lg font-bold tabular-nums">{value}</div>
        {sub && <div className="text-ui opacity-80 mt-3">{sub}</div>}
      </div>
      {children}
    </>
  );

  const cls = `rounded-xl surf-deep text-white p-5 flex flex-col min-w-0
               ${onClick ? 'is-clickable cursor-pointer transition' : ''} ${className}`;

  /*
   * ★ 可以點的做成 `<button>` —— 鍵盤走得到、讀螢幕也會說那是可按的。
   *   `text-left` 是必要的:button 預設置中，整張卡的字會全部跑到中間。
   */
  return onClick
    ? <button type="button" onClick={onClick} title={hint} className={`${cls} text-left`}>{body}</button>
    : <div className={cls}>{body}</div>;
}
