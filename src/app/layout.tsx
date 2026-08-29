import type { Metadata, Viewport } from 'next';
import './globals.css';
import SwRegister from './sw-register';

export const metadata: Metadata = {
  title: '安幸上工',
  description: '內部管理系統',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,              // iOS 加到主畫面後以全螢幕 app 開啟
    title: '安幸上工',
    statusBarStyle: 'black-translucent',
  },
  /*
   * ★★ 大小尺寸現在是**同一種畫法**（2026-08-29 改成整片填色）。
   *
   *   舊版是描邊的門 —— 描邊有內外兩條邊,縮到 16px 會黏成一團灰,
   *   所以當時得維護「32px 以下換實心」那套分岔。
   *   填滿之後只有一條邊界,分岔拆掉了。
   *
   * ★ 16 與 32 兩個尺寸還是都給:只給 32 的話瀏覽器自己縮到 16，
   *   而它縮出來的結果比我們畫的差。
   */
  icons: {
    icon: [
      { url: '/icons/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
};

// PWA / 手機:鎖住縮放比例避免點輸入框時自動放大,
// viewportFit=cover 讓內容延伸到 iPhone 的安全區域外緣(搭配 env(safe-area-inset-*) 使用)
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  /*
   * ★ 跟 `manifest.webmanifest` 的 `theme_color` **必須一致**，
   *   而且要等於全站主色 `mor-slate`。
   *
   *   舊版兩邊都寫 `#4A5A6A`，那個藍全站沒有任何地方在用 ——
   *   手機加到主畫面之後，狀態列是一個「這個 app 裡不存在的顏色」。
   */
  themeColor: '#41689B',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className="bg-mor-bg text-mor-ink antialiased">
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
