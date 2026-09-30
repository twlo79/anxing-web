'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * /cleaning → /housekeeping?tab=cleaning（2026-09-30）。
 * 清潔記錄搬進房務管理當一個分頁（housekeeping/cleaning-tab.tsx）。
 * 這一頁留著是為了推播的深連結與舊書籤 —— 刪掉的話那些連結會變 404，而沒有人會回報。
 */
export default function CleaningRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/housekeeping?tab=cleaning'); }, [router]);
  return <div className="text-sm text-gray-400 py-20 text-center">前往房務管理 → 清潔記錄…</div>;
}
