/*
 * migration_333：折讓單號（2026-10-18）
 *
 * 【David】「把折讓改成跟發票功能一樣：折讓單號｜日期｜金額｜備註；
 *          折讓單號跟發票號碼格式一樣；單號與日期非必填；備註填了就取代『折讓』顯示」
 *
 * 【這支做什麼】orders 加一欄 allowance_no（折讓單號）：
 *   · 可以空（非必填）
 *   · 有填就要是 2 碼英文 ＋ 8 碼數字 —— 跟發票號碼同一條（lib/invoice.ts 的 INV_NO_RE）
 *   · 備註不用加欄位：存在 item_name（列表上顯示的名字）
 *
 * ★ 畫面那一版會讀這一欄 —— **先跑這支，再推程式**。反過來的話收租視窗的加費列會讀不到。
 * ★ 重跑安全：if not exists ／ 先拆後建。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 */

begin;

alter table public.orders add column if not exists allowance_no text;

alter table public.orders drop constraint if exists orders_allowance_no_chk;
alter table public.orders add constraint orders_allowance_no_chk
  check (allowance_no is null or allowance_no ~ '^[A-Z]{2}[0-9]{8}$');

comment on column public.orders.allowance_no is
  '折讓單號（2 碼英文＋8 碼數字，跟發票號碼同格式）。只有折讓（負數一次性收入）會填，可以空。migration_333';

do $$
begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('333_orders_allowance_no');
  end if;
end $$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select 1 as 序, 'orders.allowance_no 這一欄' as 項目,
       coalesce((select data_type from information_schema.columns
                  where table_schema = 'public' and table_name = 'orders' and column_name = 'allowance_no'), '（沒有）') as 結果,
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'orders' and column_name = 'allowance_no')
            then '✅' else '❌' end as 判定
union all
select 2, '格式檢查（2 碼英文＋8 碼數字）',
       coalesce((select pg_get_constraintdef(oid) from pg_constraint where conname = 'orders_allowance_no_chk'), '（沒有）'),
       case when exists (select 1 from pg_constraint where conname = 'orders_allowance_no_chk') then '✅' else '❌' end
union all
select 3, '現有的折讓（參考）',
       count(*)::text || ' 筆',
       'ℹ'
  from public.orders where fee_type = '折讓'
order by 1;
