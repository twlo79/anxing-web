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

/** 必填但沒填時的框線樣式。各表單的輸入框 className 直接接這個。 */
export const badBorder = 'border-red-400 bg-red-50';
export const okBorder = 'border-gray-300';
export const reqCls = (bad: boolean) => (bad ? badBorder : okBorder);
