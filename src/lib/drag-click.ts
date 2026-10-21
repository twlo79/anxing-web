/**
 * ============================================================
 * 拖曳選字放開在視窗外，不算「點背景」（2026-10-21 David：
 * 「使用者要複製，拉滑鼠點到背景外，表單就被關了」）
 *
 * 瀏覽器的規則：按下與放開在**不同元素**上時，click 會發在兩者的**共同上層**。
 * 我們的彈窗多半是「背景包住表單、點背景＝關掉」——
 * 在輸入框裡按下、拖到外面放開 → 共同上層剛好就是背景 → 表單被關、打的字全沒了。
 *
 * 判斷「這不是點，是拖」：
 *   · 按下與放開不是同一個元素（click 被送到共同上層）
 *   · 而且滑鼠移動超過 6px
 * 兩個都成立才擋。一般的點（同一個元素按下放開）、手抖一兩 px 都不受影響。
 * ============================================================
 */
export type DragClickInput = {
  /** 按下的元素就是 click 收到的元素嗎 */
  sameTarget: boolean;
  /** click 收到的元素包住按下的那個元素嗎（瀏覽器把 click 送到共同上層時為 true） */
  clickContainsDown: boolean;
  /** 按下到放開移動了多少 px */
  dx: number;
  dy: number;
};

export const DRAG_PX = 6;

export function isDragClick(x: DragClickInput): boolean {
  if (x.sameTarget || !x.clickContainsDown) return false;
  return Math.hypot(x.dx, x.dy) > DRAG_PX;
}
