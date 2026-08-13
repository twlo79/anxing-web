'use client';

/**
 * 頁面訊息（成功／失敗）。
 *
 * ============================================================
 * 【為什麼要獨立出來，而且一定要 fixed】
 *
 * 2026-08-13：使用者說「這筆訂單寫不進去」。實際情況是 ——
 * 存檔**確實失敗了**，錯誤訊息也確實顯示了，
 * 只是它畫在頁面標題旁邊，而編輯視窗是 `fixed inset-0 z-50` 蓋滿整個畫面。
 *
 * 所以訊息被壓在視窗底下，使用者看到的是「按了儲存，什麼都沒發生」。
 *
 * 這是最糟的一種失敗：系統知道哪裡錯了、也把話說出來了，
 * 但那句話送不到需要看的人眼前。而使用者只會得出一個結論 ——
 * 「這個系統壞了」。
 *
 * 所以訊息必須浮在**所有東西**之上（z-[60] > 視窗的 z-50），
 * 而且位置固定在畫面上方中央 —— 那是視線預期出現通知的地方。
 *
 *
 * ============================================================
 * 【錯誤要按才會消失，成功自己走】
 *
 * 成功訊息是確認，看到就夠了。錯誤訊息通常帶著資料庫回傳的原因，
 * 那是使用者要拿來判斷、甚至複製給別人看的東西 ——
 * 自動消失會讓他來不及讀完，然後只能再按一次儲存看它再閃一次。
 */
export default function Toast({ msg, error, onClose }: {
  msg: string;
  error?: boolean;
  onClose?: () => void;
}) {
  if (!msg) return null;
  return (
    <div
      // assertive：錯誤要打斷讀螢幕的人在做的事，成功不用
      role="status" aria-live={error ? 'assertive' : 'polite'}
      className="fixed z-[60] left-1/2 -translate-x-1/2 px-4 w-full max-w-lg pointer-events-none"
      style={{ top: 'max(1rem, env(safe-area-inset-top))' }}>
      {error ? (
        <button onClick={onClose} title="點一下關閉"
          className="pointer-events-auto w-full text-left text-sm rounded-xl
                     bg-red-50 text-red-700 border border-red-200
                     px-4 py-3 font-medium shadow-lg shadow-black/10">
          {msg}
          <span className="block text-[11px] font-normal text-red-500/80 mt-0.5">點一下關閉</span>
        </button>
      ) : (
        <div className="pointer-events-none w-full text-sm rounded-xl
                        bg-mor-greenlight text-mor-green border border-mor-green/30
                        px-4 py-2.5 font-medium shadow-lg shadow-black/10">
          {msg}
        </div>
      )}
    </div>
  );
}
