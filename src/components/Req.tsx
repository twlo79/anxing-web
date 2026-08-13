/**
 * 必填星號。
 *
 * 【為什麼星號一開始就有，紅框卻不要】
 * 星號是「這格待會要填」的預告；紅框是「你漏了」的判決。
 * 空白表單一打開就整片紅，那不是提示是指責 —— 使用者還沒做錯任何事。
 * 紅框要在他表達「我填完了」（按下儲存）之後才出現，
 * 那時候「還缺這些」才是資訊。
 *
 * 【為什麼星號旁邊要藏一個「必填」】
 * 讀螢幕的人聽到的是「星號」——那個符號代表什麼，他得自己知道。
 * aria-hidden 把符號藏起來、補一段隱藏文字，聽到的就是「必填」。
 */
export default function Req() {
  return (
    <>
      <span aria-hidden className="text-red-500 ml-0.5">*</span>
      <span className="sr-only">必填</span>
    </>
  );
}

/**
 * 貼在輸入框角落的紅星。
 *
 * 【什麼時候用這個而不是 <Req />】
 * 有些欄位沒有標籤，提示字寫在 placeholder 或 <option> 裡
 * （請款單的項目列就是這樣，一列擠了五個控制項）。
 * 那兩個地方**只吃純文字**，塞不進元件 —— 所以那裡的星號一直是灰的。
 *
 * 這支把星號畫在框線的左上角：不佔版面、不會被輸入的文字蓋掉，
 * 而且跟有標籤的欄位是同一個紅色。
 *
 * 用法：外層加 `relative`，裡面放這個。
 */
export function ReqMark() {
  return (
    <>
      <span aria-hidden
        className="absolute -top-1.5 -left-1 z-10 text-red-500 text-sm leading-none pointer-events-none">
        *
      </span>
      <span className="sr-only">必填</span>
    </>
  );
}

/** 必填但沒填時的框線樣式。各表單的輸入框 className 直接接這個。 */
export const badBorder = 'border-red-400 bg-red-50';
export const okBorder = 'border-gray-300';
export const reqCls = (bad: boolean) => (bad ? badBorder : okBorder);
