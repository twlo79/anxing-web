-- migration_158：加費可以附照片
--
-- ============================================================
-- 【為什麼】（2026-08-22 使用者指定）
--
-- 從押金扣了 1,100 元管理費 —— 房客會問「憑什麼扣」。
-- 現在只有一行文字，沒有地方放收據、也沒有地方放
-- 「杯子破掉」那張照片。
--
-- attachments 已經掛得上請款單、支出、押金、訂單收款、押金收款，
-- **就是掛不上訂單本身** —— 而加費就是一張 orders 的子單。
--
--
-- ============================================================
-- 【att_one_parent 為什麼要整條重建】
--
-- 那條約束寫的是「這幾個 parent 欄位裡剛好只有一個有值」。
-- 加一個欄位就得把整條重寫一次 —— 漏掉新欄位的話，
-- 一筆附件可以同時掛在訂單與請款單底下，兩邊都查得到它，
-- 而刪掉其中一邊時另一邊會看到一張連不到東西的圖。
--
-- ★ 用動態 SQL 依**現有欄位**組出來，不是照抄一份清單。
--   schema-baseline.sql 已經被證實過期好幾次（少了 order_payment_id、
--   deposit_payment_id）—— 照抄等於把已經存在的欄位從約束裡刪掉。
--   migration_147 也是這樣做的，同一個理由。
-- ============================================================


-- ── ① 附件掛到訂單 ─────────────────────────────────
alter table public.attachments
  add column if not exists order_id uuid
    references public.orders(id) on delete cascade;

/*
 * on delete cascade:訂單刪了照片跟著走。
 * 這裡跟押金那條（set null）不同 —— 訂單的加費被刪掉時，
 * 那張收據就沒有任何東西指得到它了，留著只會變成永遠沒人清的孤兒檔。
 */

create index if not exists attachments_order_id_idx
  on public.attachments(order_id) where order_id is not null;

comment on column public.attachments.order_id is
  '掛在訂單（含加費子單）底下的憑證。路徑前綴 of/（migration_158）。';


-- ── ② 重建「只能有一個 parent」 ────────────────────
do $$
declare
  cols text;
  expr text;
begin
  /*
   * 從 information_schema 撈出**實際存在**的 parent 欄位。
   *
   * ★ table_schema='public' 不能少 —— attachments 這種名字
   *   在其他 schema 也有，少了條件會撈到別人的欄位（CLAUDE.md 記載的坑）。
   */
  select string_agg(quote_ident(column_name), ', ' order by column_name)
    into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'attachments'
     and column_name in ('request_id', 'expense_id', 'deposit_id',
                         'order_payment_id', 'deposit_payment_id', 'order_id');

  select string_agg('(' || quote_ident(column_name) || ' is not null)::int', ' + '
                    order by column_name)
    into expr
    from information_schema.columns
   where table_schema = 'public' and table_name = 'attachments'
     and column_name in ('request_id', 'expense_id', 'deposit_id',
                         'order_payment_id', 'deposit_payment_id', 'order_id');

  alter table public.attachments drop constraint if exists att_one_parent;
  execute format('alter table public.attachments add constraint att_one_parent check ((%s) = 1)', expr);

  raise notice 'att_one_parent 重建完成，涵蓋:%', cols;
end $$;


-- ── ③ 誰看得到加費的照片 ───────────────────────────
/*
 * 路徑格式是 `<kind>/<母層id>/<uuid>.<副檔名>`（見 Receipts.tsx）。
 * 加費的照片用 `of/`（order fee）。
 *
 * 會計／主管／總經理本來就全開（第一個分支）。
 * 管家在 migration_154 之後改得動訂單與加費，所以也要看得到 ——
 * 不然他建得了加費卻看不到自己剛傳的照片。
 *
 * ★ 一樣**只放行 of/ 與 op/**，不是把管家加進第一行的角色清單。
 *   寫進那一行等於連支出憑證與別人的請款單都一起開了。
 */
create or replace function public.can_see_receipt(p_path text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select case
    when current_role_of() in ('accountant','manager','super_admin') then true
    -- 管家:訂單的收款證明（migration_154）與加費憑證（migration_158）
    when current_role_of() = 'housekeeper'
         and (p_path like 'op/%' or p_path like 'of/%') then true
    -- 其他人只看得到自己送的請款單底下的附件
    else exists (
      select 1
      from public.attachments a
      join public.purchase_requests p on p.id = a.request_id
      where a.path = p_path and p.requester_id = auth.uid()
    )
  end;
$function$;

create or replace function public.can_edit_receipt(p_path text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select case
    when current_role_of() in ('accountant','manager','super_admin') then true
    when current_role_of() = 'housekeeper'
         and (p_path like 'op/%' or p_path like 'of/%') then true
    else exists (
      select 1
      from public.purchase_requests p
      where p.id = nullif(split_part(p_path, '/', 2), '')::uuid
        and p.requester_id = auth.uid()
        and p.status in ('draft','rejected','pending')
    )
  end;
$function$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('158_order_fee_receipt');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★ 只能有一個 SELECT —— SQL Editor 只顯示最後一個的結果。
 */
select "檢查項目", "結果", "說明" from (

  select 1 as ord, '★★ attachments.order_id' as "檢查項目",
         count(*)::text || ' / 1' as "結果",
         case when count(*) = 1 then '✅ 加費掛得上照片了' else '❌' end as "說明"
    from information_schema.columns
   where table_schema = 'public' and table_name = 'attachments' and column_name = 'order_id'

  union all
  /*
   * ★★ 這一項最重要:約束必須涵蓋**全部**六個 parent 欄位。
   *   漏掉任何一個，那個欄位就等於沒有防線 ——
   *   一筆附件可以同時掛兩個地方，而兩邊都查得到它。
   */
  select 2, '★★ att_one_parent 涵蓋幾欄',
         (length(pg_get_constraintdef(oid))
           - length(replace(pg_get_constraintdef(oid), 'IS NOT NULL', '')))
           / length('IS NOT NULL') || ' 欄',
         case when pg_get_constraintdef(oid) like '%order_id%'
               and pg_get_constraintdef(oid) like '%order_payment_id%'
               and pg_get_constraintdef(oid) like '%deposit_payment_id%'
               and pg_get_constraintdef(oid) like '%request_id%'
               and pg_get_constraintdef(oid) like '%expense_id%'
              then '✅ 六個 parent 欄位都在'
              else '❌ 有欄位漏掉了：' || pg_get_constraintdef(oid) end
    from pg_constraint
   where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent'

  union all
  select 3, '★ 管家看得到加費照片',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname in ('can_see_receipt','can_edit_receipt')
                      and pg_get_functiondef(p.oid) like '%of/%') = 2
              then '✅ 2 / 2' else '❌ 函式沒改到' end,
         '他建得了加費，就要看得到自己傳的照片'

  union all
  select 4, '★ 支出憑證仍未對管家開放',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname in ('can_see_receipt','can_edit_receipt')
                      and pg_get_functiondef(p.oid) like '%housekeeper%exp/%') = 0
              then '✅' else '❌ 不小心開到支出憑證了' end,
         '只放行 op/ 與 of/'

  union all
  select 5, '既有附件', count(*)::text || ' 筆',
         '這支只加欄位，一筆都沒有動到'
    from public.attachments

) v order by ord;
