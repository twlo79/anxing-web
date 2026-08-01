import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = { title: '安幸上工', description: '內部管理系統' };

// PWA / 手機:鎖住縮放比例避免點輸入框時自動放大,
// viewportFit=cover 讓內容延伸到 iPhone 的安全區域外緣(搭配 env(safe-area-inset-*) 使用)
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#4A5A6A',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className="bg-mor-bg text-mor-ink antialiased">{children}</body>
    </html>
  );
}
