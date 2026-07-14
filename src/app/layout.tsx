import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: '安幸上工', description: '內部管理系統' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className="bg-mor-bg text-mor-ink antialiased">{children}</body>
    </html>
  );
}
