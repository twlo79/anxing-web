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
  icons: {
    icon: [{ url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' }],
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
  themeColor: '#4A5A6A',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className="bg-[#EAE7E0] text-mor-ink antialiased">
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
