/*
 * migration_338_housekeeper_read_expenses.sql　2026-10-20
 * 管家看得到「支出明細」，但不能新增／編輯／刪除
 *
 * 【David】「支出明細管家連看都看不到 —— 可以看得到，但不能編輯」
 *
 * 【這一支做的事】（只加「讀」，一條寫入都沒加）
 *   ① expenses 多一條 SELECT 規則給管家（exp_read_hk）
 *      寫入那條 exp_write 不動 —— 還是只有會計、主管、總經理
 *   ② 支出底下的憑證圖片，管家也看得到：
 *      · 支出自己的（exp/…）
 *      · 支出是從請款單產生的，借看那張請款單的（整張 pr/…、逐項 pri/…）—— 只限「已經產生支出」的請款單
 *      ★ 做法同 migration_334：另外加幾條專用的「讀」規則，不去改 can_see_receipt（它管了十幾種附件）
 *      ★ 沒有任何 insert／update／delete 規則
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor。★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 *   先跑這支，再推程式（選單才會出現「支出明細」）。
 * ══════════════════════════════════════════════════════════
 */

begin;

do $do$
begin
  if to_regclass('public.expenses') is null or to_regclass('public.attachments') is null
     or to_regprocedure('public.current_role_of()') is null then
    raise exception 'expenses／attachments／current_role_of() 有一個不在 —— 整支停下來';
  end if;
end $do$;

-- ══════ ① 支出：管家可以讀 ══════
drop policy if exists exp_read_hk on public.expenses;
create policy exp_read_hk on public.expenses for select
  using (public.current_role_of() = 'housekeeper');

-- ══════ ② 支出的憑證：管家可以讀 ══════
create or replace function public.can_see_exp_att_hk(p_path text)
returns boolean language sql stable security definer set search_path to 'public' as $fn$
  select public.current_role_of() = 'housekeeper' and exists (
    select 1 from public.attachments a
     where a.path = p_path
       and ( a.expense_id is not null
          or exists (select 1 from public.purchase_requests p
                      where p.id = a.request_id and p.expense_generated_at is not null)
          or exists (select 1 from public.purchase_request_items i
                       join public.purchase_requests p on p.id = i.request_id
                      where i.id = a.request_item_id and p.expense_generated_at is not null)));
$fn$;
comment on function public.can_see_exp_att_hk(text) is
  '管家看支出頁的憑證（migration_338）：支出自己的、以及已經產生支出的請款單的。只讀。';

drop policy if exists att_read_exp_hk on public.attachments;
create policy att_read_exp_hk on public.attachments for select
  using (public.can_see_exp_att_hk(path));

drop policy if exists exp_obj_read_hk on storage.objects;
create policy exp_obj_read_hk on storage.objects for select
  using (bucket_id = 'receipts' and (name like 'exp/%' or name like 'pr/%' or name like 'pri/%')
         and public.can_see_exp_att_hk(name));

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('338_housekeeper_read_expenses');
  end if;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select 1 as 序, '支出：管家讀（exp_read_hk）' as 檢查,
       case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'expenses' and policyname = 'exp_read_hk') then '有' else '沒有' end as 結果,
       case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'expenses' and policyname = 'exp_read_hk') then '✅' else '❌' end as 判定
union all
select 2, '支出：寫入規則還是沒有管家',
       coalesce((select string_agg(policyname, '、') from pg_policies
                  where schemaname = 'public' and tablename = 'expenses' and cmd <> 'SELECT'
                    and coalesce(qual, '') || coalesce(with_check, '') ilike '%housekeeper%'), '（沒有）'),
       case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'expenses' and cmd <> 'SELECT'
                    and coalesce(qual, '') || coalesce(with_check, '') ilike '%housekeeper%') then '❌' else '✅' end
union all
select 3, '憑證：管家讀（附件表＋檔案）',
       (select count(*) from pg_policies where policyname in ('att_read_exp_hk', 'exp_obj_read_hk'))::text || ' / 2',
       case when (select count(*) from pg_policies where policyname in ('att_read_exp_hk', 'exp_obj_read_hk')) = 2 then '✅' else '❌' end
order by 1;
