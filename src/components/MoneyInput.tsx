'use client';
import { useRef } from 'react';
import { formatAmount, parseAmount, toInput, caretAfterFormat } from '@/lib/money-input';

/**
 * 金額輸入框：邊打邊加千分位。
 *
 * 【為什麼是 text 不是 number】
 * `<input type="number">` 不接受逗號 —— 打進去整格會變空的。
 * 所以要顯示千分位就只能自己來。`inputMode="numeric"` 保住手機的數字鍵盤。
 *
 * 【為什麼要自己管游標】
 * 逗號會在游標前面憑空多出字元，不處理的話瀏覽器會把游標丟到最後面 ——
 * 使用者想改中間那一位數，結果每打一個字游標就跳到尾巴。
 * 定位改用「游標前面有幾個數字」，逗號怎麼加都不影響。
 *
 * 算法在 lib/money-input，有測試。這裡只負責接上 DOM。
 */
export default function MoneyInput({
  value, onChange, disabled, placeholder = '0', className = '', invalid,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** 必填但沒填 —— 畫紅框 */
  invalid?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);

  return (
    <input
      ref={ref}
      type="text" inputMode="decimal" disabled={disabled}
      value={toInput(value)} placeholder={placeholder}
      onChange={(e) => {
        const before = e.target.value;
        const caret = e.target.selectionStart ?? before.length;
        const after = formatAmount(before);
        onChange(parseAmount(after));
        /*
         * 下一個 tick 才設游標。
         *
         * React 會用新的 value 重繪這個 input，重繪之後瀏覽器把游標
         * 放在字串尾端 —— 現在設的話會馬上被那次重繪蓋掉。
         */
        const pos = caretAfterFormat(before, caret, after);
        requestAnimationFrame(() => {
          const el = ref.current;
          if (el && document.activeElement === el) el.setSelectionRange(pos, pos);
        });
      }}
      className={`${className} ${invalid ? 'border-red-400 bg-red-50' : ''}`}
    />
  );
}
