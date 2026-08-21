-- 查：管家（housekeeper）在「契約編輯」與「訂單編輯」裡，哪些資料表碰得到
--
-- ============================================================
-- 【為什麼要查】（2026-08-21）
--
-- 已知 contract_recurring_charges 的 RLS 只給 accountant / manager /
-- super_admin，而前端 <ContractFees canEdit /> 是寫死 true ——
-- 管家按得下去，但 **insert 被 RLS 擋下時 PostgREST 回成功、影響 0 列**，
-- 畫面顯示「已儲存」，重整之後什麼都沒有。
--
-- 要全站開放給管家之前，得先知道**還有幾張表是同一個狀況**。
-- 用猜的不行:schema-baseline.sql 已經被證實過期（缺 order_payments、
-- deposits.lines、attachments.order_payment_id），只能問線上的 pg_policy。
--
-- ★ 這支**只讀，不改任何東西**。跑完把三張表貼回來。
-- ============================================================


-- ── ① 一張表看完:每個表、每個動作，管家碰不碰得到 ─────
/*
 * 判斷方式:policy 的條件式裡有沒有出現 'housekeeper'，
 * 或者是「只要是員工就可以」（current_role_of() IS NOT NULL）。
 *
 * permissive policy 之間是 OR —— 只要有一條放行就過得去，
 * 所以這裡用 bool_or。
 */
with t(tbl, ord, 用途) as (values
  ('contracts',                 1, '契約主檔'),
  ('contract_recurring_charges',2, '固定加費 ← 已知擋住'),
  ('orders',                    3, '訂單／收入單'),
  ('order_payments',            4, '訂單收款明細'),
  ('invoices',                  5, '發票'),
  ('attachments',               6, '照片與附件'),
  ('estates',                   7, '物業（下拉選單）'),
  ('properties',                8, '房源（下拉選單）'),
  ('payment_accounts',          9, '收款帳戶（下拉選單）')
)
select
  t.ord            as "#",
  t.tbl            as "資料表",
  t.用途           as "用途",
  case when bool_or(
        p.polcmd in ('r','*')
        and (pg_get_expr(p.polqual, p.polrelid) like '%housekeeper%'
          or pg_get_expr(p.polqual, p.polrelid) like '%current_role_of() IS NOT NULL%')
       ) then '✅' else '❌' end as "讀",
  case when bool_or(
        p.polcmd in ('a','*')
        and (coalesce(pg_get_expr(p.polwithcheck, p.polrelid),
                      pg_get_expr(p.polqual, p.polrelid)) like '%housekeeper%'
          or coalesce(pg_get_expr(p.polwithcheck, p.polrelid),
                      pg_get_expr(p.polqual, p.polrelid)) like '%current_role_of() IS NOT NULL%')
       ) then '✅' else '❌' end as "新增",
  case when bool_or(
        p.polcmd in ('w','*')
        and (pg_get_expr(p.polqual, p.polrelid) like '%housekeeper%'
          or pg_get_expr(p.polqual, p.polrelid) like '%current_role_of() IS NOT NULL%')
       ) then '✅' else '❌' end as "修改",
  case when bool_or(
        p.polcmd in ('d','*')
        and (pg_get_expr(p.polqual, p.polrelid) like '%housekeeper%'
          or pg_get_expr(p.polqual, p.polrelid) like '%current_role_of() IS NOT NULL%')
       ) then '✅' else '❌' end as "刪除",
  count(p.polname) as "政策數"
from t
left join pg_class c
       on c.relname = t.tbl
      and c.relnamespace = 'public'::regnamespace
left join pg_policy p on p.polrelid = c.oid
group by t.ord, t.tbl, t.用途
order by t.ord;


-- ── ② 上面判斷不了的，看原文 ───────────────────────
/*
 * ① 用的是字串比對 —— 條件式如果繞路寫（例如查另一張表、
 * 或用 auth.uid() 直接比對），字串裡就看不到 'housekeeper'，
 * 會被誤判成 ❌。所以原文一定要一起看。
 */
select
  c.relname as "資料表",
  p.polname as "政策",
  case p.polcmd when 'r' then 'select' when 'a' then 'insert'
                when 'w' then 'update' when 'd' then 'delete'
                else 'ALL' end as "動作",
  pg_get_expr(p.polqual, p.polrelid)      as "USING",
  pg_get_expr(p.polwithcheck, p.polrelid) as "WITH CHECK"
from pg_policy p
join pg_class c on c.oid = p.polrelid
where c.relnamespace = 'public'::regnamespace
  and c.relname in (
    'contracts','contract_recurring_charges','orders','order_payments',
    'invoices','attachments','estates','properties','payment_accounts')
order by c.relname, p.polname;


-- ── ③ 附件的權限藏在函式裡 ─────────────────────────
/*
 * attachments 的政策是 can_see_receipt(path) / can_edit_receipt(path) ——
 * 條件式裡不會出現角色名字，②也看不出來。要看函式本體。
 */
select p.proname as "函式", pg_get_functiondef(p.oid) as "定義"
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('can_see_receipt','can_edit_receipt','current_role_of')
order by p.proname;
