/*
 * 查-管家在支出的權限.sql　2026-10-20（只讀，不改任何東西）
 * 【David】「確認管家在支出只能讀，不能寫／編輯」
 * 列出支出相關幾張表的權限規則（RLS），每一條寫「管家能不能」。
 * 整份貼進 Supabase SQL Editor 跑，看最後那一張表。
 */
select p.tablename                                   as 表,
       case p.tablename
         when 'expenses'               then '支出明細'
         when 'purchase_requests'      then '請款單'
         when 'purchase_request_items' then '請款單項目'
         when 'deposits'               then '押金／折讓退款'
         when 'attachments'            then '憑證附件'
       end                                           as 是什麼,
       p.policyname                                  as 規則,
       p.cmd                                         as 動作,
       case when coalesce(p.qual, '') || coalesce(p.with_check, '') ilike '%housekeeper%' then '有寫到管家'
            when coalesce(p.qual, '') || coalesce(p.with_check, '') ilike '%requester_id = auth.uid()%' then '自己建的單可以'
            else '沒有管家' end                       as 管家,
       left(coalesce(p.qual, p.with_check, ''), 160) as 條件
  from pg_policies p
 where p.schemaname = 'public'
   and p.tablename in ('expenses', 'purchase_requests', 'purchase_request_items', 'deposits')
 order by 1, 4, 3;
