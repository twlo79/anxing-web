'use client';
import Link from 'next/link';

/**
 * 各列表頁「新增」旁邊的回收桶入口。
 *
 * 【為什麼帶 table 參數】
 * 不帶的話會落在「全部」的清單 —— 訂單只佔其中一小段，
 * 使用者還要再篩一次。從訂單頁點進去就該只看到訂單的刪除紀錄。
 *
 * 【為什麼不是實心按鈕】
 * 它跟「新增」不是同一個層級的動作。做成一樣顯眼的按鈕，
 * 兩個都會變得不顯眼 —— 而「新增」才是這一列的主角。
 */
export default function TrashLink({ table, label = '刪除紀錄' }: { table: string; label?: string }) {
  return (
    <Link href={`/settings?tab=trash&table=${encodeURIComponent(table)}`}
      title={`查看已刪除的${label === '刪除紀錄' ? '資料' : label}`}
      aria-label="查看刪除紀錄"
      className="rounded-lg border border-mor-line bg-white px-3 py-1.5 text-gray-500
                 hover:bg-mor-sand/60 hover:text-mor-slate transition-colors">
      🗑️
    </Link>
  );
}
