'use client';

/**
 * 押金退款的欄位組。押金管理頁與請款頁的抽屜共用。
 *
 * 【為什麼要抽出來】
 * 這些欄位原本只寫在押金頁。請款頁也要能編輯的時候,如果複製一份過去,
 * 兩邊就會開始各自演化 —— 一邊加了驗證、一邊改了標籤,半年後沒人知道哪個是對的。
 * 錢會照著這裡填的帳號匯出去,兩份長得不一樣的表單是不能接受的。
 *
 * 【兩個帳戶方向相反,不要看錯】
 *   payee_*          = 房客的收款帳戶 —— 錢**退到哪**
 *   returned_method  = 我方的出款方式
 *   returned_account = 我方的出款帳號 —— 錢**從哪出**
 * 命名沿用請款單,全站一致。
 *
 * 這支只管欄位。狀態分支(已核可鎖住、已退款、駁回原因)留在各自的頁面 ——
 * 那是流程,不是欄位,兩頁的呈現本來就不同。
 */

export type RefundDraft = {
  payee_bank_code?: string | null;
  payee_name?: string | null;
  payee_account?: string | null;
  planned_refund_on?: string | null;
  returned_method?: string | null;
  returned_account?: string | null;
};

export type RefundPayAccount = { code: string; name: string; method: string };

/** 押金的收退方式。比請款單多一個加密貨幣 —— 押金真的收過。 */
export const METHOD_LABEL: Record<string, string> = {
  cash: '現金', transfer: '匯款', credit_card: '信用卡', crypto: '加密貨幣',
};
export const METHOD_OPTS = ['cash', 'transfer', 'credit_card', 'crypto'];

const CTRL = 'h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5';

export default function RefundFields({ v, onChange, payAccounts, currency }: {
  v: RefundDraft;
  /** 只送變動的欄位,由呼叫端自己決定怎麼合併進 state */
  onChange: (patch: Partial<RefundDraft>) => void;
  payAccounts: RefundPayAccount[];
  currency?: string;
}) {
  return (
    <>
      <div className="text-xs text-gray-400 mb-1.5">房客的收款帳戶</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">銀行代碼</span>
          <input value={v.payee_bank_code ?? ''}
            onChange={(e) => onChange({ payee_bank_code: e.target.value })}
            placeholder="例:806" className={CTRL} /></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">戶名 *</span>
          <input value={v.payee_name ?? ''}
            onChange={(e) => onChange({ payee_name: e.target.value })} className={CTRL} /></label>
        <label className="flex flex-col gap-1 md:col-span-2"><span className="text-xs text-gray-500">帳號 *</span>
          <input value={v.payee_account ?? ''}
            onChange={(e) => onChange({ payee_account: e.target.value })} className={CTRL} /></label>
      </div>

      <div className="text-xs text-gray-400 mt-3 mb-1.5">我方出款</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">預計匯款日 *</span>
          <input type="date" value={v.planned_refund_on ?? ''}
            onChange={(e) => onChange({ planned_refund_on: e.target.value || null })} className={CTRL} /></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">出款方式 *</span>
          {/* 換方式就把帳號清掉 —— 留著上一個方式的帳號會匯錯地方 */}
          <select value={v.returned_method ?? ''}
            onChange={(e) => onChange({ returned_method: e.target.value || null, returned_account: null })}
            className={CTRL}>
            <option value="">請選擇</option>
            {METHOD_OPTS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
          </select></label>
        {/* 現金沒有帳戶可言 */}
        {v.returned_method && v.returned_method !== 'cash' && (
          <label className="flex flex-col gap-1 md:col-span-2"><span className="text-xs text-gray-500">出款帳號（我方）</span>
            <select value={v.returned_account ?? ''}
              onChange={(e) => onChange({ returned_account: e.target.value || null })} className={CTRL}>
              <option value="">未指定</option>
              {payAccounts.filter((a) => a.method === v.returned_method)
                .map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
            </select></label>
        )}
      </div>

      {currency && currency !== 'TWD' && (
        <p className="text-xs text-gray-400 mt-2">外幣押金原幣退還,不換匯。</p>
      )}
    </>
  );
}
