/*
 * audit_advance_candidates —— 哪些已出款的請款單其實是暫支款（唯讀）
 * ============================================================
 * 2026-09-02 使用者：「先查，看有幾筆再決定」
 *
 * 暫支款的功能還沒接上（請款單那邊連勾選框都還沒有），所以**過去所有
 * 押金、保證金都被記成了當月支出**。這支把它們找出來。
 *
 * ============================================================
 * 【★★ 這支只會「像」，不會「確定」】
 *
 * 判斷靠的是品名／摘要／科目裡的關鍵字 —— 那是猜測，不是事實。
 * 所以最後一欄叫「★ 像不像」而不是「是不是」，而且**列出原文**
 * 讓你自己看，不要只看我的判斷。
 *
 * ★ 寧可多列幾筆讓你打叉，也不要漏掉一筆還在外面的錢
 *   —— 漏的那筆沒有任何地方會提醒（CLAUDE.md:「寧可晚一天報」的反面:
 *   這裡是一次性的盤點，誤報的成本只是多看幾列）。
 *
 * ★★ 但也不能無限放寬。「押」這個字單獨抓會掃到「押運」「抵押」，
 *   所以用的是完整詞（押金／保證金／押標／履約保證／擔保／保證），
 *   而每一列都把原文印出來供你核對。
 *
 * 整份照貼，全選再按 Run。**只有 select，不會改任何東西。**
 */

select
  r.req_no                                        as "單號",
  r.purchased_on                                  as "出款日",
  /*
   * ★ 收款對象是 `payee_company`。**沒有 `payee_name` 這個欄位**
   *   —— 2026-09-01 已經踩過一次，今天又寫了一次。
   *   欄位清單在 schema-baseline.sql:286：
   *     payee_bank_code / payee_account / payee_company / payee_tax_id
   */
  coalesce(r.payee_company, r.payee_account, '（沒填）') as "收款對象",
  i.item_name                                     as "品名（原文）",
  coalesce(i.note, '')                            as "摘要（原文）",
  i.amount                                        as "金額",
  coalesce(i.account_code, '（沒填）')              as "會計科目",
  coalesce(a.name, '')                            as "科目名稱",
  coalesce(e.name, '')                            as "物業",
  /*
   * ★★ 出款帳戶。暫支收回時錢要**回到同一個帳戶**（2026-09-02 使用者指定），
   *   所以搬進暫付的話這一欄就是 advance_payments.paid_account 的來源。
   *   這裡先看有沒有填 —— 沒填的話搬過去也不知道該退回哪裡。
   */
  coalesce(r.payout_account, '（沒填）')            as "出款帳戶",
  /*
   * ★ 有沒有已經產生的支出。有的話「搬進暫付」就等於要倒掛那一筆 ——
   *   而那會讓歷史月份的支出總額變小。決定要不要搬之前先看這一欄。
   */
  (select count(*) from public.expenses x
    where x.source_item_id = i.id)                as "已產生支出筆數",
  case
    when i.item_name ~ '押金|保證金|押標|履約保證|擔保金'
      or coalesce(i.note, '') ~ '押金|保證金|押標|履約保證|擔保金'
                                                  then '⚠⚠⚠ A 很像 —— 品名或摘要直接寫了'
    when i.item_name ~ '保證|擔保|押'
      or coalesce(i.note, '') ~ '保證|擔保|押'     then '⚠ B 有點像 —— 只出現單字，要自己看原文'
    else 'C 只是同一個對象／科目，多半不是'
  end                                             as "★ 像不像"
from public.purchase_request_items i
join public.purchase_requests r on r.id = i.request_id
left join public.account_codes a on a.code = i.account_code
left join public.estates e on e.id = i.estate_id
where r.purchased_on is not null                  -- 已經出款的才算數
  and (
    i.item_name ~ '保證|擔保|押'
    or coalesce(i.note, '') ~ '保證|擔保|押'
  )
order by
  case
    when i.item_name ~ '押金|保證金|押標|履約保證|擔保金'
      or coalesce(i.note, '') ~ '押金|保證金|押標|履約保證|擔保金' then 1
    else 2
  end,
  r.purchased_on desc;
