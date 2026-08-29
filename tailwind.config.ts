import type { Config } from 'tailwindcss';
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      /*
       * ══════════════════════════════════════════════════════
       * 全站字級 +2px（2026-08-28 使用者:「整站 字體 也大一些」×2）
       *
       * ★★ 動這裡而不是去改 1,500 個 class。
       *   `text-xs` 用了 886 次、`text-sm` 552 次 ——
       *   一個個改的話漏掉幾個沒有人會發現,而畫面會東大西小。
       *
       * ★ +2px（2026-08-28 使用者要了兩次「大一些」）。
       *
       * ⚠ 這個幅度**密集表格可能會換行** —— 請款單、支出、訂單那三頁
       *   欄位最多,推完務必先看它們。太擠的話把這裡調回 +1px 就好,
       *   那是**一個檔案六行**的事,不用去動任何頁面。
       *
       * ★ 行高跟著加,比例維持 ——
       *   只加字級不加行高的話,兩行的儲存格會擠在一起。
       *
       * ⚠ **寫死 px 的地方不會跟著變**（`text-[13px]` 那些）。
       *   那些已經另外調過一輪了,新增時請優先用 text-xs / text-sm。
       * ══════════════════════════════════════════════════════
       */
      fontSize: {
        xs:   ['0.875rem',  { lineHeight: '1.25rem' }],    // 12 → 14
        sm:   ['1rem',      { lineHeight: '1.5rem' }],     // 14 → 16
        base: ['1.125rem',  { lineHeight: '1.75rem' }],    // 16 → 18
        lg:   ['1.25rem',   { lineHeight: '1.875rem' }],   // 18 → 20
        xl:   ['1.375rem',  { lineHeight: '2rem' }],       // 20 → 22
        '2xl': ['1.625rem', { lineHeight: '2.25rem' }],    // 24 → 26
      },
      colors: {
        mor: {
          bg: '#F1F0EC',
          line: '#E0DDD5',
          ink: '#2E3840',
          slate: '#41689B',     // 主色:更飽和的藍
          slatedark: '#345380',
          blue: '#4E96D1',      // 進度條藍(鮮豔)
          bluelight: '#DFEDFA',
          green: '#3FAE7C',     // 進度條綠(鮮豔)。★ 只能當「面」,當文字只有 2.78:1
          greendark: '#217346', // 匯出鈕的綠(文字與邊框)。5.82:1。剛好是 Excel 自己的綠
          greenlight: '#DFF2E8',
          sand: '#ECE8DF',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
