'use client';
import type { ReactNode } from 'react';

/**
 * 分頁籤 —— 全站唯一一份（2026-08-29 使用者:「tab 有好幾種形式 也要統一」）。
 *
 * ============================================================
 * 【盤點:同一個東西有五種長相】
 *
 *   房務管理    底線 ＋ 主色字
 *   出勤        圓角膠囊塞在一個淺色面板裡
 *   出勤·管理   同上,但小一號（分頁裡還有分頁）
 *   其他收支帳  實心藍膠囊（帳本）＋ 底線（收支帳/儀錶板）—— 一頁兩種
 *   帳戶明細    小的實心膠囊
 *   請款單      底線 ＋ 一顆數字徽章
 *
 * 不是誰寫錯了 —— 是**沒有一個地方定義「分頁籤長什麼樣」**。
 * 而這種不一致 `tsc` 與測試都抓不到:class 打錯不會報錯,只會變醜。
 *
 *
 * ============================================================
 * 【★★ 兩種樣式，各有各的意思 —— 不是「挑好看的」】
 *
 *   `segment`（分段膠囊，**有容器**）  切換**這一頁的哪個區塊**
 *                   打卡／申請／核可、行事曆／排班統計、請款審核／請款單。
 *                   容器把它們框成一組:一眼看得出「這幾個是一夥的」。
 *
 *   `solid`（圓膠囊，**沒容器**）      切換**哪一份資料**
 *                   愛皮／洪鯊、元大 70564／24145／48088。
 *                   換一個就是換一整批東西。
 *
 * ★ 一頁可以同時有兩種（其他收支帳:先選帳本，再選檢視）——
 *   那正是為什麼不能統一成同一種。**它們回答的是不同的問題。**
 *   兩種放在一起也不會混淆:圓膠囊獨立浮著、分段膠囊有一個容器,
 *   形狀與有沒有容器都不同。
 *
 *
 * ============================================================
 * 【★★★ 底線那種退場了】（2026-08-29）
 *
 * 第一版留了 `line`（底線）給「換檢視」。實際套下去發現:
 *
 *   ① 五個底線 tab 攤在 1440px 寬的頁面上,那條 2px 的線是**很弱的訊號**
 *   ② 一頁裡出現三種 tab 就是回到原點 —— 而那正是這件事要解決的問題
 *
 * 使用者的話:「出勤換了 沒比較好」—— 出勤原本就是分段膠囊,
 * 那是這幾種裡最好的一種。**所以讓它當標準，其他頁配合它。**
 *
 *
 * ============================================================
 * 【★★★ 兩層同性質的分頁，只能靠「包覆」表達從屬】
 *
 * 出勤的「管理」底下還有四個子項。原本兩層長得一樣、左緣對齊、
 * 中間沒有邊界 —— 畫面上就是**九個平行選項**。
 *
 * ★ 這兩層是**同一種性質**（都是換區塊）,不能靠換形狀分 ——
 *   所以把第二層放進第一層打開的**卡片裡**（見 attendance/admin-tab.tsx）。
 *
 * ★ 對照:其他收支帳那兩層不用包,因為性質不同,形狀本身就說完了。
 *
 *
 * ============================================================
 * 【★ 徽章放數字，不放狀態】
 *
 * 請款單的「請款審核 13」是「有 13 件等你」。
 * 徽章只在 `> 0` 時出現 —— 顯示 `0` 等於用一個醒目的記號說「沒事」,
 * 那會訓練人忽略它,而它真正有事的時候就沒有人看了。
 */

export type TabItem<T extends string> = {
  key: T;
  label: ReactNode;
  /** 右上角的數字。0 或 undefined 不畫 —— 見檔頭。 */
  badge?: number;
};

export function Tabs<T extends string>({
  items, value, onChange, variant = 'segment', size = 'md', tone = 'paper', className = '',
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (k: T) => void;
  /**
   * segment = 換這一頁的區塊（浮著）
   * solid   = 換哪一份資料（圓膠囊，浮著）
   * browser = Chrome 式分頁。內容是一整塊時包 `<TabShell>`，
   *           是一疊卡片時（tone="page"）直接用，不用包
   */
  variant?: 'segment' | 'solid' | 'browser';
  /** sm 給「分頁裡的分頁」用 —— 兩層一樣大的話看不出誰包誰 */
  size?: 'sm' | 'md';
  /**
   * 底下接的是什麼。**選中的分頁一律白底**（2026-08-29「active 變白」），
   * 所以這個值現在只用來決定 `<TabShell>` 的面板底色。
   *
   *   paper  白面板 —— 內容本身就是一整塊（清單、表格）
   *   page   不包面板 —— 內容是**一疊卡片**（統計卡、篩選卡、表格卡）
   *
   * ★★★ 為什麼要分（2026-08-29）:白卡放在白面板上**邊界會消失**。
   *   出勤·打卡那種一連串區塊的頁面，包進白面板會整個糊成一塊。
   */
  tone?: 'paper' | 'page';
  className?: string;
}) {
  const md = size === 'md';

  /*
   * ══════════════════════════════════════════════════════════
   * Chrome 式分頁 —— 第一層（換整個頁面在看什麼）。
   *
   * ★★ 歷史:第一版讓分頁**無邊框地浮在面板上方**,使用者說
   *   「銜接怪怪的」—— 選中第二個時面板左上角是圓的,分頁掛在半空中。
   *   第二版改成「分頁列是面板的一部分 ＋ 深一階的底色條」,接縫解決了,
   *   但那條底色橫跨整頁而且不帶資訊。
   *
   * ★★★ 第三版（現在）:每一頁都有自己的框,不需要底色條,
   *   也不需要靠「跟面板同色」去藏接縫 —— 選中的那頁自己就有三個訊號。
   *   詳見底下的註解。
   * ══════════════════════════════════════════════════════════
   */
  if (variant === 'browser') {
    /*
     * ══════════════════════════════════════════════════════════
     * ★★★ 長相定案（2026-08-29，來回四輪）:
     *
     *   「不想有底色，都畫出來，但 active 的 tab 亮」
     *   → A／B 融合，未選的框線用正常深度
     *   → 「active 換顏色 加底線」
     *   → 「橫線等寬」「active 變白」
     *
     *   ┌──────┐ ┌──────┐ ┌──────┐
     *   │ 打卡 │ │ 申請 │ │ 核可 │   ← 三個都有框
     *   └══════┷═┷──────┷═┷──────┴───────────────  ← 橫線橫跨整個寬度
     *     藍字白底              灰字透明底
     *
     * ★★ 選中的那頁有**三個訊號**:白底 ＋ 主色字 ＋ 下緣 2px 主色線。
     *   疊三個是刻意的 —— 不靠顏色單獨傳達，色弱的人靠框與底色也分得出來。
     *
     * ★★★ 橫線要**等寬**。前一版每個分頁各有各的下緣線，
     *   五個分頁後面就沒有線了 —— 那排看起來是浮在半空中的五個方塊。
     *   做法:容器有一條 `border-b`，分頁用 `-mb-px` 往下拉一格，
     *   讓它們 2px 的下緣線**蓋在那條線上**。整條線是連續的，
     *   只有選中的那一段是藍的。
     *
     * ★★★ `overflow-x-auto` 要放在**外層**，不能跟 `border-b` 同一層。
     *   CSS 規定 `overflow-x: auto` 會把 `overflow-y` 的 visible 變成 auto ——
     *   分頁那 `-mb-px` 就會被裁掉，還冒出一條垂直捲軸。
     *   外層捲、內層畫線，兩件事分開。
     *
     * ★★★ 選中的那頁**一律白底**，不跟著 `tone` 走。
     *   原本 `tone="page"` 時選中的是頁面米色 —— 那跟旁邊未選的透明底
     *   幾乎一樣，三個訊號少掉一個。白色在米色頁面上才是「亮起來」。
     *
     * ★★ 三種狀態的 border 寬度**完全一樣**（上左右 1px、下 2px），
     *   只有顏色不同。用 `border-b-0` 給未選、`border-b-2` 給選中的話，
     *   兩者高度差 2px，整排分頁的文字基線會上下跳。
     *
     * ★ 未選的框線用 `mor-line` 正常深度，不要調淡 —— 淡到像影子就退回
     *   「只有選中的有形狀」，而那正是「其他頁看起來不像分頁」的老問題。
     * ══════════════════════════════════════════════════════════
     */
    return (
      <div className={`overflow-x-auto ${className}`}>
        <div className="flex gap-1 border-b border-mor-line" role="tablist">
        {items.map((t) => {
          const on = t.key === value;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={on}
              onClick={() => onChange(t.key)}
              className={`${md ? 'px-4 py-2 text-ui' : 'px-3 py-1.5 text-uisub'}
                -mb-px rounded-t-[10px] border border-b-2 border-mor-line
                font-medium whitespace-nowrap transition-colors ${
                on ? 'bg-white border-b-mor-slate text-mor-slate'
                   : 'border-b-mor-line bg-transparent text-gray-500 hover:bg-white/50'}`}>
              {t.label}
              <Badge n={t.badge} on={on} />
            </button>
          );
        })}
        </div>
      </div>
    );
  }

  if (variant === 'solid') {
    return (
      <div className={`flex flex-wrap gap-2 ${className}`} role="tablist">
        {items.map((t) => {
          const on = t.key === value;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={on}
              onClick={() => onChange(t.key)}
              className={`${md ? 'h-10 px-5 text-ui' : 'h-9 px-4 text-uisub'}
                rounded-full font-medium whitespace-nowrap transition-colors ${
                on ? 'bg-mor-slate text-white'
                   : 'bg-white border border-mor-line text-gray-600 hover:bg-mor-sand/60'}`}>
              {t.label}
              <Badge n={t.badge} on={on} />
            </button>
          );
        })}
      </div>
    );
  }

  /*
   * ★ 容器用 `inline-flex` 而不是 `flex` —— 它只該有內容那麼寬。
   *   滿版的話那個淺色框會橫跨整頁,看起來像一條空的工具列。
   *
   * ★ `overflow-x-auto`:項目多的時候（出勤有五個）手機放不下,
   *   讓它橫向捲而不是折行 —— 折行會讓容器變成兩層樓,
   *   而那看起來像兩組不同的東西。
   */
  return (
    <div className={`inline-flex max-w-full gap-1 overflow-x-auto rounded-xl
                     bg-white/45 backdrop-blur border border-white/60
                     ${md ? 'p-1' : 'p-[3px]'} ${className}`}
      role="tablist">
      {items.map((t) => {
        const on = t.key === value;
        return (
          <button key={t.key} type="button" role="tab" aria-selected={on}
            onClick={() => onChange(t.key)}
            className={`${md ? 'px-4 py-1.5 text-ui rounded-lg' : 'px-3 py-1 text-uisub rounded-md'}
              font-medium whitespace-nowrap transition-colors ${
              on ? 'bg-white text-mor-slate shadow-[0_2px_8px_-2px_rgba(46,56,64,0.25)]'
                 : 'text-gray-500 hover:text-gray-700'}`}>
            {t.label}
            <Badge n={t.badge} on={on} />
          </button>
        );
      })}
    </div>
  );
}

/** 數字徽章。★ `> 0` 才畫 —— 見檔頭「不放 0」。 */
function Badge({ n, on }: { n?: number; on: boolean }) {
  if (!n || n <= 0) return null;
  return (
    <span className={`ml-1.5 inline-flex items-center justify-center rounded-full
      px-1.5 min-w-[1.25rem] h-5 text-uisub font-semibold tabular-nums ${
      on ? 'bg-mor-slate text-white' : 'bg-amber-100 text-amber-800'}`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

/**
 * Chrome 式分頁的外殼:分頁列 ＋ 面板。
 *
 * ============================================================
 * 【★★ 改版後這個殼變薄了】（2026-08-29）
 *
 * 舊版的殼要處理「接縫」：分頁列是面板的一部分、`overflow-hidden`
 * 讓上緣吃到圓角、選中的那頁跟面板同色連成一片。
 *
 * 現在**沒有接縫可處理**了 —— 分頁不再是無邊框地掛在面板上緣,
 * 每一頁都有自己的框、選中的那頁下緣是一條主色線。
 * 所以這個殼只剩「把分頁列跟面板排在一起」這一件事。
 *
 * ★★★ `overflow-hidden` **拿掉了**。
 *   舊版靠它吃圓角,但它同時是一個坑:`.glass` 的 `backdrop-blur`
 *   會讓裡面 `position: fixed` 的彈窗改以這個殼為定位基準而被裁掉。
 *   現在不需要它,那個坑也就不存在了 —— `tone="page"` 也可以放心包。
 *
 * 用法:
 *   <TabShell tabs={<Tabs variant="browser" … />}>
 *     …面板內容…
 *   </TabShell>
 */
export function TabShell({ tabs, children, tone = 'paper', className = '' }: {
  tabs: ReactNode; children: ReactNode;
  /** ★ 要跟裡面那個 `<Tabs tone>` **填一樣的值** —— 面板色要跟選中那頁一致 */
  tone?: 'paper' | 'page';
  className?: string;
}) {
  return (
    <div className={className}>
      {tabs}
      {/*
        ★ 面板不做左上圓角（`rounded-tl-none`）—— 第一頁選中時
          分頁的左緣要跟面板的左緣切齊,做圓角會露出一個缺口。
        ★ `-mt-px` 讓面板的上框線疊在分頁的下緣線底下,
          不然會出現兩條平行線。
      */}
      <div className={`-mt-px rounded-xl rounded-tl-none border border-mor-line
                       ${tone === 'page' ? 'bg-mor-bg' : 'bg-white'}`}>
        {/* ★ `-mt-px` 把面板的上框線疊到分頁那條橫線上 —— 不然會有兩條平行線 */}
        {children}
      </div>
    </div>
  );
}
