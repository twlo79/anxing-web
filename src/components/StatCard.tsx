'use client';
import type { ReactNode } from 'react';

/**
 * 統計卡 —— 全站唯一一份（2026-08-25 使用者:「幫我統一，然後簡約，減少不必要資訊」）。
 *
 * ============================================================
 * 【為什麼要有這支】
 *
 * 盤點時卡片容器有 **87 種寫法**。同一種東西在契約、暫收、帳戶三頁
 * 長得完全不同:
 *
 *   契約   選中 = 實心藍底
 *   暫收   選中 = 實心藍底,但上排的卡比下排小一號
 *   帳戶   選中 = 淺藍底 ＋ 外框（第三種做法）
 *
 * 不是誰寫錯了 —— 是**沒有一個地方可以定義「卡片長什麼樣」**。
 *
 * ★★ 這種不一致 `tsc` 與測試**都抓不到**:class 打錯不會報錯,
 *    只會變醜。所以唯一的防線是「只有一個地方可以改」。
 *
 *
 * ============================================================
 * 【★★ 這幾張卡是一條線,不是一堆格子】
 *
 * （2026-08-25 使用者:「手機版不好讀,其實這是一個線性關係耶」）
 *
 *     未付 → 已收 → 已結案
 *
 * 第一版手機用兩欄網格,而**三個階段塞進兩欄**的結果是:
 * 第三個掉到第二行左邊、右邊空一格 —— 順序斷掉了,
 * 看起來像「上面兩個一組,下面那個是別的東西」。
 *
 * 所以:
 *   手機  直向堆疊,上到下就是流程
 *   桌機  橫向三欄,左到右**也是**同一條流程
 *
 * 兩種都在表達順序,只是方向不同。
 *
 *
 * ============================================================
 * 【簡約:什麼不放】
 *
 * ★ 沒有 `hint` 這種「解釋這張卡在說什麼」的第四行。
 *   標題寫得對的話不需要解釋;寫不對的話,要改的是標題。
 *
 * ★ `sub` 只放**數字**（筆數、外幣、其中幾筆），不放句子。
 */

/** 色系。★ 一個群組一種顏色 —— 訂金與押金是兩種錢,不該同色 */
export type Tone = 'slate' | 'amber';

const TONE = {
  /* 主色。長期擺著的錢（押金）、一般用途 */
  slate: { fill: 'bg-mor-slate border-mor-slate hover:bg-mor-slatedark', dot: 'bg-mor-slate' },
  /*
   * 琥珀。★ 還沒定案的錢（訂金）—— 三條出路都還沒走。
   *
   * ★ 刻意不用綠色:綠在這個系統裡是「已收／通過」的意思
   *   （mor-green 用在已收款與核可）。拿它當訂金會讓人
   *   以為那些錢的狀態是「好的」,而訂金的重點是「還沒決定」。
   */
  amber: { fill: 'bg-amber-600 border-amber-600 hover:bg-amber-700', dot: 'bg-amber-600' },
} as const;

export default function StatCard({
  label, value, sub, active, accent, muted, tone = 'slate', onClick,
}: {
  /** 標題。★ 要能單獨看懂 —— 看不懂就改標題,不要加解釋 */
  label: ReactNode;
  value: ReactNode;
  /** 副標。只放數字（3 筆・USD 700），不放句子 */
  sub?: ReactNode;
  /** 選中（同時是分頁籤時）。★ 一組最多一張 */
  active?: boolean;
  /**
   * 「輪到你」（2026-08-25 從請款單搬進來）。外框加粗成主色，底維持白。
   *
   * ★★ 這**不是** active 的另一種畫法 —— 兩者是不同的問題:
   *
   *     active  「你現在在看這一組」   —— 使用者自己按出來的
   *     accent  「這一張等你動作」     —— 系統告訴他的
   *
   *   同一畫面可能兩個都在（正在看待核可、而待核可正好輪到你）,
   *   所以不能共用同一個樣式。實心留給 active,accent 只加重外框。
   *
   * ★ 一個畫面最多一張。兩張以上就沒有「輪到你」的意思了。
   */
  accent?: boolean;
  /** 空的 / 不適用。整張淡化 —— **不拿掉**,拿掉的話看的人不知道那個狀態存在 */
  muted?: boolean;
  tone?: Tone;
  onClick?: () => void;
}) {
  /*
   * ★ 可點就是 <button>，不可點就是 <div>。
   *   全部用 button 的話,不能點的卡片會被鍵盤 Tab 到、
   *   而按下去什麼都不會發生 —— 用鍵盤的人會以為壞了。
   */
  const Tag: any = onClick ? 'button' : 'div';
  const t = TONE[tone];

  /*
   * ★★ **同一份 DOM,靠斷點切排法** —— 不是兩份標記各顯示一半。
   *
   *   手機:一列（label ─ 金額靠右 ─ 筆數）
   *   桌機:一張卡（label / 金額 / 筆數 三行）
   *
   *   渲染兩份再各自 hidden 的話,畫面上看不見的那份仍然存在 ——
   *   螢幕閱讀器會唸兩次,而且改了一份忘了另一份不會有任何跡象。
   */
  return (
    <Tag {...(onClick ? { type: 'button', onClick } : {})}
      className={[
        'text-left border transition-colors min-w-0',
        'rounded-lg px-3 py-2.5 md:rounded-xl md:px-4 md:py-3',
        'flex items-baseline gap-2 md:block',
        active ? t.fill
          /*
           * ★ accent 用 border-2 而不是 ring —— ring 畫在框線外面,
           *   同一列裡有 accent 的那張會比別張高出 2px,看起來像沒對齊。
           *   ★ 同時把 muted 讓給 accent:兩個都成立時（輪到你、但是 0 筆）
           *     淡化會蓋掉「輪到你」,而那正是最需要看見的一張。
           */
          : accent ? 'bg-white border-2 border-mor-slate'
          : 'bg-white/85 border-mor-line',
        onClick && !active ? 'hover:bg-white/45' : '',
        muted && !active && !accent ? 'opacity-55' : '',
      ].filter(Boolean).join(' ')}>
      <span className={`text-xs leading-tight shrink-0 md:block ${
        active ? 'text-white/80' : accent ? 'text-mor-slate font-medium' : 'text-gray-500'}`}>
        {label}
      </span>
      {/*
        stat-num 用 clamp 隨螢幕寬度連續變化 —— 金額位數不固定,斷點切換會撐破卡片。
        ★ 手機 ml-auto 把金額推到最右 —— 三列的數字才上下切齊,而它們本來就該比大小。
      */}
      <span className={`stat-num font-bold ml-auto md:ml-0 md:block md:mt-0.5 ${
        active ? 'text-white' : accent ? 'text-mor-slate' : ''}`}>
        {value}
      </span>
      {sub != null && sub !== '' && (
        <span className={`text-[13px] shrink-0 md:block md:mt-0.5 ${
          active ? 'text-white/75' : 'text-gray-400'}`}>
          {sub}
        </span>
      )}
    </Tag>
  );
}

/**
 * 一組階段。**手機直向、桌機橫向** —— 見檔頭「這幾張卡是一條線」。
 *
 * ★ `cols` 是桌機的欄數。同一組固定一個數字,**每張卡一樣寬** ——
 *   暫收那邊上排三張曾經比下排小一號,看起來像兩種不同的東西。
 */
export function StatRow({
  children, cols = 3, className = '',
}: { children: ReactNode; cols?: 2 | 3 | 4; className?: string }) {
  const md = { 2: 'md:grid-cols-2', 3: 'md:grid-cols-3', 4: 'md:grid-cols-4' }[cols];
  return (
    <div className={`grid grid-cols-1 ${md} gap-1.5 md:gap-3 ${className}`}>
      {children}
    </div>
  );
}

/**
 * 群組標題。★ 前面一個小色塊,跟這一組卡片的選中色相同 ——
 * 純文字標題在捲動時很容易被忽略,而色塊讓眼睛自己把標題跟卡片連起來。
 */
export function StatGroup({ label, tone = 'slate' }: { label: ReactNode; tone?: Tone }) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      <span className={`w-1.5 h-1.5 rounded-sm shrink-0 ${TONE[tone].dot}`} />
      <span className="text-xs text-gray-500">{label}</span>
    </div>
  );
}

/**
 * 一行大字的總計。
 *
 * ★ 不做成卡片 —— 總計是拿來**瞄一眼**的,不是拿來點的。
 *   做成卡片會跟旁邊可點的卡片長得一樣,而它按下去什麼都不會發生。
 */
export function StatTotal({
  label, value, sub,
}: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 mb-3">
      <span className="text-sm text-gray-500">{label}</span>
      <span className="stat-num-lg font-bold text-mor-slate tabular-nums">{value}</span>
      {sub != null && sub !== '' && <span className="text-sm text-gray-400">{sub}</span>}
    </div>
  );
}
