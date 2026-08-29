import type { Config } from 'tailwindcss';
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      /*
       * ══════════════════════════════════════════════════════
       * ★★★ 字級**不做全域覆寫**（2026-08-29 使用者釐清）。
       *
       * 一度把 xs/sm/base 全部 +2px。但 `text-xs` 用了 886 次、
       * `text-sm` 552 次 —— 那幾乎全是**表格內文**,
       * 而表格正是最不該變大的地方:欄位一多就換行,
       * 而換行的表格比小一點的字難讀得多。
       *
       * ★ 使用者要的是「**menu 按鈕 標題 卡片 filter** 變大」——
       *   那是**介面外框**,不是資料。兩者要分開調。
       *
       * ★★ 所以外框的字級各自寫在它自己的元件裡:
       *     標題      globals.css 的 h1 / h2
       *     按鈕      globals.css 的 .btn ＋ components/Actions.tsx
       *     篩選      lib/filters.tsx（FILTER_CTRL / Field）
       *     統計卡    components/StatCard.tsx
       *     側邊選單  app/(app)/layout.tsx
       *
       *   五個地方,不是 1,500 個 class —— 之後要再調也是改這五個。
       * ══════════════════════════════════════════════════════
       */
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
