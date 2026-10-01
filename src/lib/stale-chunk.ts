/**
 * 「Loading chunk 5904 failed」—— 不是檔案壞，是**頁面是舊版**。（2026-10-01）
 *
 * Next.js 每次部署，程式碼切成一塊塊帶雜湊的檔名；舊版頁面還開著、
 * 第一次要用到某一塊（例如按「預覽 Word」才載入的 mammoth）時去抓，
 * 而那一塊在新部署裡已經不存在 → 404 → ChunkLoadError。
 *
 * 症狀：剛推完版，使用者在開著的分頁上按預覽 → 紅字「這份 Word 打不開」。
 * 他會以為是檔案壞了、重傳一次，而重傳沒有用 —— 要做的只是重新整理。
 * 所以訊息要講對原因，而且給一顆「重新整理」。
 */
export function isStaleChunkError(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  const msg = String(err?.message ?? e ?? '');
  return err?.name === 'ChunkLoadError'
    || /Loading chunk [\w-]+ failed/i.test(msg)
    || /Failed to fetch dynamically imported module/i.test(msg);
}

export const STALE_CHUNK_MSG = '系統剛更新過，這一頁還是舊版 —— 重新整理再點一次就好。檔案本身沒有問題。';
