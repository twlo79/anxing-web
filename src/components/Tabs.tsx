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
   * browser = Chrome 式分頁 —— **必須包在 `<TabShell>` 裡**，見下方
   */
  variant?: 'segment' | 'solid' | 'browser';
  /** sm 給「分頁裡的分頁」用 —— 兩層一樣大的話看不出誰包誰 */
  size?: 'sm' | 'md';
  /**
   * `browser` 專用:底下的面板是什麼顏色。**選中的那頁要跟面板同色**,
   * 否則接縫會露出一條邊。
   *
   *   paper  白面板 —— 內容本身就是一整塊（清單、表格）
   *   page   頁面底色 —— 內容是**一疊卡片**（統計卡、篩選卡、表格卡）
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
   * Chrome 式分頁。**只能放在 `<TabShell>` 裡**。
   *
   * ★★★ 為什麼一定要有那個殼（2026-08-29 使用者:「銜接怪怪的」）
   *
   *   第一版讓分頁**浮在面板上方**,結果三個結構性問題:
   *
   *     ① 選中第二個時,面板的左上角是圓的 —— 分頁掛在半空中接不上。
   *        要配合「選第幾個」去改面板圓角,那是永遠修不完的。
   *     ② 分頁列與面板是兩個獨立元素,中間**永遠會差一條縫**。
   *     ③ 外凸圓角用 `::before/::after` 要**寫死背景色**,換底色就露餡。
   *
   * ★★ 修法:**分頁列是面板的一部分**。
   *   分頁列有自己的底色（比面板深一階）,選中的那頁是面板色、
   *   直接連到下面,中間沒有線。
   *
   *   這樣**選第幾個都對** —— 面板永遠是完整的方框。
   *
   * ★ 這也是 Chrome 真正的做法:它的分頁列是**視窗的一部分**,
   *   不是浮在視窗上面的東西。
   * ══════════════════════════════════════════════════════════
   */
  if (variant === 'browser') {
    /*
     * ★ 分頁列的底色要比面板**深一階**,不然分頁的形狀撐不起來。
     *   白面板配沙色列、米色面板配線色列 —— 兩組的色差都夠。
     */
    const strip = tone === 'page' ? 'bg-mor-line' : 'bg-mor-sand';
    const active = tone === 'page' ? 'bg-mor-bg' : 'bg-white';
    /*
     * ★★★ `tone="page"` **不需要 `<TabShell>`**。
     *
     *   選中的那頁跟頁面同色,所以它自己就跟下面的頁面連在一起了 ——
     *   下面有沒有一個「面板」都一樣。
     *
     * ★★ 而且**不能**用 TabShell 包:那個殼有 `overflow-hidden`,
     *   而 `.glass` 的 `backdrop-blur` 會讓 `position: fixed` 的彈窗
     *   改以它為定位基準 —— 彈窗會被裁掉。
     *   那幾頁的編輯視窗全部是 fixed,包進去就打不開了。
     *
     * ★ 所以只有 `tone="paper"`（白面板、內容是一整塊）才配 TabShell。
     */
    return (
      <div className={`flex gap-[3px] overflow-x-auto px-1.5 pt-1.5 ${strip}
                       ${tone === 'page' ? 'rounded-t-xl' : ''} ${className}`}
        role="tablist">
        {items.map((t) => {
          const on = t.key === value;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={on}
              onClick={() => onChange(t.key)}
              className={`${md ? 'px-4 py-2 text-ui' : 'px-3 py-1.5 text-uisub'}
                rounded-t-[9px] font-medium whitespace-nowrap transition-colors ${
                on ? `${active} text-mor-slate`
                   : 'text-gray-500 hover:bg-white/40'}`}>
              {t.label}
              <Badge n={t.badge} on={on} />
            </button>
          );
        })}
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
 * Chrome 式分頁的外殼:**分頁列 ＋ 面板是同一個容器**。
 *
 * ★ `overflow-hidden` 讓分頁列的上緣自動吃到容器的圓角 ——
 *   分頁自己不用管圓角要幾度。
 *
 * ★ 面板是實心白（不是 `glass`）—— 分頁列靠「白 vs 沙色」的色差
 *   撐起形狀,半透明會讓那個色差隨背景浮動。
 *
 * 用法:
 *   <TabShell tabs={<Tabs variant="browser" … />}>
 *     …面板內容…
 *   </TabShell>
 */
export function TabShell({ tabs, children, tone = 'paper', className = '' }: {
  tabs: ReactNode; children: ReactNode;
  /** ★ 要跟裡面那個 `<Tabs tone>` **填一樣的值** —— 不一樣的話接縫會露邊 */
  tone?: 'paper' | 'page';
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-mor-line overflow-hidden
                     ${tone === 'page' ? 'bg-mor-bg' : 'bg-white'} ${className}`}>
      {tabs}
      {children}
    </div>
  );
}
