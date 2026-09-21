/*
 * 查-24195出現的那幾列.sql　2026-09-21
 * 只讀不寫。回一張表。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼還要再查一次】
 *
 * 上一支的第 ⑨ 段（包含式，參考用）掃到六個地方有「24195」，
 * 而其中**至少一個是巧合**:
 *
 *     reviews.airbnb_review_id   ← Airbnb 的評價編號裡剛好有這五個數字
 *
 * 誤報混在真的裡面，整份清單就失去意義（CLAUDE.md 判斷原則）。
 * 所以這一支**把那幾列真的印出來**，一眼分得掉哪個是哪個。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 兩個欄位長得像，意思相反 —— 不要看錯】
 *
 *     payout_account   **我方**付款帳戶　錢從哪一個戶頭出去
 *     payee_account    **對方**收款帳號　錢匯到誰的戶頭
 *
 * 24195 出現在 `payee_account` 的意思是「安幸把錢匯給愛皮」，
 * **不是**「用愛皮的帳戶付錢」。兩件事在新規則下的判定完全相反。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 用 to_jsonb(t.*)->>'欄位' 取值，不直接寫欄位名】
 *
 * 欄位名我只在別的檔案裡看過，沒有親眼確認過線上長什麼樣。
 * 直接寫 `p.req_no` 的話，名字不對就是 42703 整支炸掉；
 * `j->>'req_no'` 取不到只會回 null —— **這一格空著，其他格照印**。
 * （跟「憑印象寫既有函式的簽章」同一條，README 二-6。）
 * ══════════════════════════════════════════════════════════
 */

select * from (

  /* ── ⓪ 每一段的欄位意思不一樣，先說清楚 ───────────────
     ★ 四張表的形狀不同，硬塞進同一組欄名一定會有幾格意思跑掉。
       與其假裝一致，不如把對照表印在最上面。 */
  select 0 as ord, '⓪ 怎麼讀' as "表",
         '① 請款單' as "單號／編號", '帳本' as "帳本",
         '我方付款帳戶' as "我方付款帳戶", '對方收款帳號' as "對方收款帳號",
         '代墊給' as "代墊給", '出款日' as "日期"
  union all
  select 0, '⓪ 怎麼讀', '② 常用帳號', '公司', '—', '帳號', '銀行代碼', '啟用中？'
  union all
  select 0, '⓪ 怎麼讀', '③ 對帳單', '帳戶', '摘要', '存入', '支出', '交易日'
  union all
  select 0, '⓪ 怎麼讀', '④ 評價', '房客', '—', '—', '—', '退房日'

  union all
  /* ── ① 請款單：收款帳號是愛皮的那幾張 ─────────────────
     ★ 這是「安幸付錢給愛皮」的單，看一下是不是代墊收回那幾筆。 */
  select 1 as ord,
         'purchase_requests' as "表",
         coalesce(j ->> 'req_no', '（沒有單號）')            as "單號／編號",
         coalesce(j ->> 'book', '（空的）')                  as "帳本",
         coalesce(j ->> 'payout_account', '（空的）')        as "我方付款帳戶",
         coalesce(j ->> 'payee_account', '')                 as "對方收款帳號",
         coalesce(j ->> 'advance_for_book', '—')             as "代墊給",
         coalesce(j ->> 'purchased_on', '（還沒出款）')      as "日期"
    from (select to_jsonb(p.*) as j from public.purchase_requests p
           where p.payee_account like '%24195%') s

  union all
  /* ── ② 常用帳號：那一筆是誰 ───────────────────────── */
  select 2, 'payee_presets',
         coalesce(j ->> 'label', '（沒有顯示名）'),
         coalesce(j ->> 'company', '—'),
         '—',
         coalesce(j ->> 'account', ''),
         coalesce(j ->> 'bank_code', '—'),
         case when coalesce((j ->> 'active')::boolean, true) then '啟用中' else '已停用' end
    from (select to_jsonb(x.*) as j from public.payee_presets x
           where x.account like '%24195%') s

  union all
  /* ── ③ 銀行對帳單：11 筆，最可能是巧合 ─────────────────
     ★ ref_no 是對帳單自己的交易編號，長數字裡湊出五碼很常見。
       印出來看一眼:如果 11 筆的日期／金額毫無關聯，就是巧合。 */
  select 3, 'bank_transactions',
         coalesce(j ->> 'ref_no', ''),
         coalesce(j ->> 'account', j ->> 'account_code', '（空的）'),
         coalesce(j ->> 'summary', j ->> 'note', j ->> 'memo', '—'),
         coalesce(j ->> 'amount_in', j ->> 'deposit', '—'),
         coalesce(j ->> 'amount_out', j ->> 'withdraw', '—'),
         coalesce(j ->> 'txn_date', j ->> 'date', j ->> 'trade_date', '—')
    from (select to_jsonb(b.*) as j from public.bank_transactions b
           where b.ref_no like '%24195%') s

  union all
  /* ── ④ 評價：確認它就是巧合 ───────────────────────── */
  select 4, 'reviews（應該是巧合）',
         coalesce(j ->> 'airbnb_review_id', ''),
         coalesce(j ->> 'guest_name', j ->> 'reviewer', '—'),
         '—', '—', '—',
         coalesce(j ->> 'checkout', j ->> 'review_date', j ->> 'created_at', '—')
    from (select to_jsonb(r.*) as j from public.reviews r
           where r.airbnb_review_id like '%24195%'
              or coalesce(r.source_url, '') like '%24195%') s

  union all
  /* ★★★ 一列都沒有要說出來 —— 空的結果跟「沒查到」長得一樣 */
  select 9, '（什麼都沒撈到）',
         '⚠ 四段都是空的 —— 上一支的 ⑨ 段跟這一支問的不是同一件事，把兩張表一起貼回來',
         '', '', '', '', ''
   where not exists (select 1 from public.purchase_requests p where p.payee_account like '%24195%')
     and not exists (select 1 from public.payee_presets x where x.account like '%24195%')
     and not exists (select 1 from public.bank_transactions b where b.ref_no like '%24195%')

) v(ord, "表", "單號／編號", "帳本", "我方付款帳戶", "對方收款帳號", "代墊給", "日期")
order by v.ord, v."日期", v."單號／編號";
