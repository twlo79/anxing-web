'use client';
import type { ReactNode } from 'react';

/**
 * 表單「其他功能」裡的摺疊（2026-09-24，契約與訂單表單共用）。原生 <details>，不用自己管 state。
 *
 * ★ 收起時 summary 那句現況照樣顯示 —— 不用點開也看得到；warn 的用橘字（價格未稅那種）。
 * ★ defaultOpen 只在掛上去時算數；換一筆資料要重算預設的話，母層把外面的容器 key 綁 id。
 * ★ 內容區是兩欄 grid，跟表單本體一樣 —— 搬進來的區塊 `col-span-2` 照用。
 */
export default function Fold({ title, summary, warn, defaultOpen, children }: {
  title: string; summary?: string; warn?: boolean; defaultOpen?: boolean; children?: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="col-span-2 rounded-xl border border-mor-line bg-white group">
      <summary className="list-none cursor-pointer select-none flex items-center gap-2 px-3 py-2 text-sm">
        <span className="text-[10px] text-gray-400 transition-transform group-open:rotate-90">▶</span>
        <span className="font-medium">{title}</span>
        {summary && <span className={`ml-auto text-right text-xs ${warn ? 'text-amber-700' : 'text-gray-400'}`}>{summary}</span>}
      </summary>
      <div className="border-t border-mor-line bg-[#FAFAF9] px-3 py-2.5 grid grid-cols-1 md:grid-cols-2 gap-3">{children}</div>
    </details>
  );
}
