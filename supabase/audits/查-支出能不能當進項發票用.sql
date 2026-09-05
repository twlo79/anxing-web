/*
 * 查-支出能不能當進項發票用（唯讀）
 * ============================================================
 * 2026-09-05 使用者：「稅務管理可以從支出抓到進項，然後自動計算稅金」
 *
 * 【抓得到，但抓得到多少要先看】
 *
 * 一筆支出要變成一張可扣抵的進項發票，需要四樣東西：
 *
 *   ① 發票號碼        —— `voucher_no` 可能是，也可能是收據號
 *   ② **賣方統一編號** —— 申報要，而支出頁上好像沒這一欄
 *   ③ **稅額**        —— `amount` 是含稅還是未稅？拆稅要知道
 *   ④ **可不可以扣抵** —— 三聯式可以；二聯式收據、交際費、
 *                        乘人小客車、國外的都不行
 *
 * ★★★ 缺 ② ③ 的話「自動計算稅金」只能算個估計值，
 *   而估計值在報稅單上會變成一個錯的數字，沒有人會發現
 *   —— 那比不自動更糟。
 *
 * ★ 這一支先問**現在有什麼**，不設計、不改任何東西。
 *   `expenses` 的欄位清單我沒有在手上，而憑印象寫欄位名今天錯過三次。
 *
 * 【怎麼跑】整份貼進 SQL Editor，把結果貼回來。唯讀。
 */

select v.ord, v."項目", v."內容", v."判定" from (

  -- ══════════ ★★★ expenses 到底有哪些欄位 ══════════
  select 100 as ord, '★★★ expenses 的欄位清單' as a,
         (select string_agg(column_name || ' ' || data_type
                   || case when is_nullable = 'YES' then '' else ' NN' end, '、'
                   order by ordinal_position)
            from information_schema.columns
           where table_schema = 'public' and table_name = 'expenses') as b,
         'ℹ 找「統編」「稅」「發票」這三種字' as d

  -- ══════════ ② 有沒有賣方統編 ══════════
  union all
  select 200, '★★ 有沒有可以放賣方統編的欄位',
         coalesce((select string_agg(column_name, '、')
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'expenses'
                      and (column_name ilike '%tax_id%' or column_name ilike '%vendor%'
                           or column_name ilike '%payee%' or column_name ilike '%supplier%')),
                  '（一個都沒有）'),
         '❗ 沒有的話，進項發票的「廠商統編」欄永遠是空的'

  -- ══════════ ③ 有沒有稅額欄位 ══════════
  union all
  select 300, '★★ 有沒有稅額／未稅金額的欄位',
         coalesce((select string_agg(column_name, '、')
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'expenses'
                      and (column_name ilike '%tax%' or column_name ilike '%net%')),
                  '（一個都沒有）'),
         '❗ 沒有的話只能用 amount ÷ 1.05 反推,而那假設每一筆都含 5% 稅'

  -- ══════════ ① voucher_no 長什麼樣 ══════════
  union all
  select 400, '憑證號碼填了幾筆',
         (select count(*)::text from public.expenses where coalesce(voucher_no, '') <> '')
           || ' 筆有號碼，' || (select count(*)::text from public.expenses
                                where coalesce(no_voucher, false)) || ' 筆勾了無憑證，'
           || (select count(*)::text from public.expenses
                where coalesce(voucher_no, '') = '' and not coalesce(no_voucher, false))
           || ' 筆兩者皆無（總共 ' || (select count(*)::text from public.expenses) || ' 筆）',
         '★ 「兩者皆無」那些抓不進來 —— 沒有發票號碼就不是發票'

  union all
  -- ★ 統一發票號碼是「兩個英文字母 ＋ 八個數字」。不合這個格式的多半是收據
  select 410, '★ 憑證號碼裡有幾筆長得像統一發票',
         (select count(*)::text from public.expenses
           where voucher_no ~ '^[A-Za-z]{2}[0-9]{8}$')
           || ' 筆合格式，' ||
         (select count(*)::text from public.expenses
           where coalesce(voucher_no, '') <> '' and voucher_no !~ '^[A-Za-z]{2}[0-9]{8}$')
           || ' 筆不合（那些多半是收據、繳款單）',
         '★★ 只有合格式的才可能可扣抵'

  union all
  select 420, '不合格式的長什麼樣（前 10 種）',
         coalesce((select string_agg(v, '、') from (
                     select distinct left(voucher_no, 14) as v from public.expenses
                      where coalesce(voucher_no, '') <> ''
                        and voucher_no !~ '^[A-Za-z]{2}[0-9]{8}$'
                      limit 10) s), '（沒有）'),
         'ℹ 看看是不是有別種合法的寫法'

  -- ══════════ ④ 這一期實際有多少可抓 ══════════
  union all
  select 500, '★★★ 115年9-10月期（2026-09-01~10-31）的支出',
         (select count(*)::text || ' 筆，合計 $' || coalesce(sum(amount), 0)::text
            from public.expenses
           where spent_on between date '2026-09-01' and date '2026-10-31'),
         case when (select count(*) from public.expenses
                     where spent_on between date '2026-09-01' and date '2026-10-31') = 0
              then '⚠ 這一期還沒有支出 —— 拿上一期試比較準'
              else '✅ 有母體' end

  union all
  select 510, '★ 上一期（115年7-8月）的支出與其中有發票號碼的',
         (select count(*)::text from public.expenses
           where spent_on between date '2026-07-01' and date '2026-08-31')
           || ' 筆，其中格式像統一發票的 ' ||
         (select count(*)::text from public.expenses
           where spent_on between date '2026-07-01' and date '2026-08-31'
             and voucher_no ~ '^[A-Za-z]{2}[0-9]{8}$') || ' 筆',
         '★★★ 這兩個數字的差距 = 自動抓進來之後，還要人工補的量'

  -- ══════════ 已經手 key 的進項長什麼樣（對照組） ══════════
  union all
  select 600, '目前 tax_invoice 裡的進項',
         coalesce((select count(*)::text || ' 筆，稅額合計 ' || coalesce(sum(tax_amount), 0)::text
                     from public.tax_invoice where kind = 'in'), '（沒有）'),
         'ℹ 現在是手 key 的'

  union all
  select 610, '★ 進項發票的稅額跟未稅額是什麼關係',
         coalesce((select string_agg(
                     net_amount::text || ' + ' || tax_amount::text || ' = ' || total_amount::text
                     || case when net_amount > 0
                             then '（稅率 ' || round(tax_amount * 100.0 / net_amount, 1)::text || '%）'
                             else '' end, E'\n')
                     from (select * from public.tax_invoice
                            where kind = 'in' and not voided limit 5) s), '（沒有進項可以看）'),
         '★ 確認是「未稅 × 5% = 稅額」還是別的算法'

) v(ord, "項目", "內容", "判定")
order by v.ord;
