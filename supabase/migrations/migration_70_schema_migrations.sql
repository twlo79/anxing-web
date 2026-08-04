-- migration_70：migration 執行紀錄
--
-- 【問題】
-- 沒有任何地方記錄哪幾支跑過。實際踩到的：
--   * migration_63 重跑，第二次因為資料已經處理過而中止（守衛把「已完成」誤判成「不一致」）
--   * 「64 65 我跑了耶」—— 跑完之後沒有憑據，只能靠記憶
--   * 換一台電腦、或之後有人接手，完全不知道線上跑到哪
--
-- migration 是**手動貼進 Supabase SQL Editor** 跑的（沒有 supabase link，
-- db push 需要 Docker），所以沒辦法自動化。那就至少把「跑過什麼」記下來。
--
-- 【用法】
-- 每支 migration 最後加一行：
--     select record_migration('68_hk_drop_is_common');
-- 想知道還有哪些沒跑：
--     select * from pending_migrations;   -- 需要先貼上檔名清單，見下方
--
-- 【為什麼不是回填全部 30~67】
-- 只回填「確定跑過」的。跑沒跑過我猜不出來，猜錯比沒有紀錄更糟 ——
-- 那會讓人以為已經跑了而跳過。所以 30~67 一律標成 assumed，
-- 意思是「線上狀態看起來是跑過的，但不是當下記錄的」。

create table if not exists public.schema_migrations (
  name        text primary key,
  applied_at  timestamptz not null default now(),
  applied_by  uuid,
  -- assumed = 事後回填的推測值，不是當下記錄的。看到這個要自己確認。
  source      text not null default 'recorded' check (source in ('recorded', 'assumed'))
);

comment on table public.schema_migrations is
  '哪幾支 migration 跑過。migration 是手動貼進 SQL Editor 執行的，'
  '這張表是唯一的憑據 —— 每支結尾都要 select record_migration(''檔名去掉 migration_ 與 .sql'')。';

alter table public.schema_migrations enable row level security;

-- 讀給所有登入者（要判斷有沒有漏跑），寫只給 super_admin
drop policy if exists schema_migrations_read on public.schema_migrations;
create policy schema_migrations_read on public.schema_migrations
  for select using (auth.role() = 'authenticated');

drop policy if exists schema_migrations_write on public.schema_migrations;
create policy schema_migrations_write on public.schema_migrations
  for all using (current_role_of() = 'super_admin')
  with check (current_role_of() = 'super_admin');

create or replace function public.record_migration(p_name text)
returns text language plpgsql security definer set search_path = public as $$
declare existing timestamptz;
begin
  select applied_at into existing from schema_migrations where name = p_name;
  if existing is not null then
    -- 不擋重跑 —— 有些 migration 本來就設計成可重跑。但要說出來。
    return format('⚠ %s 之前跑過了（%s）。若這支不是冪等的，先確認資料沒被做兩次。',
                  p_name, to_char(existing, 'YYYY-MM-DD HH24:MI'));
  end if;
  insert into schema_migrations (name, applied_by) values (p_name, auth.uid());
  return format('✓ 已記錄 %s', p_name);
end $$;

comment on function public.record_migration(text) is
  '記錄一支 migration 跑過。已經跑過的話回傳警告而不是報錯 —— '
  '有些 migration 是冪等的，重跑本來就沒問題，但要讓人知道。';

-- ── 回填 ───────────────────────────────────────────
-- 30~67 標成 assumed：線上 schema 的狀態顯示它們都生效了
-- （schema-baseline.sql 是 2026-08 的線上快照，對得起來），
-- 但那是推測，不是當下記錄的。
insert into public.schema_migrations (name, source, applied_at)
select x, 'assumed', '2026-08-01'::timestamptz
from unnest(array[
  '30_pr_expenses','31_staff_profiles','32_pr_cancel_selfapprove','33_position_as_role',
  '34_purpose_estate','35_push_subscriptions','36_push_trigger','37_push_url',
  '38_payment_accounts','39_pay_plan','40_currency','41_accountant_receipts',
  '42_accountant_invoice','43_accountant_contract','44_accountant_full',
  '44_fix_accountant_guard','45_fix_review_property','46_account_codes','47_expense_room',
  '48_concessions','49_pay_plan_at_request','50_edit_pending','51_receipts','52_voucher',
  '53_recognition_rounding','54_pr_voucher_to_expense','55_expense_request_link',
  '56_deposits','57_manual_deposit','58_housekeeping','59_hk_maintainable',
  '60_hk_manual_count','61_deposit_refund_flow','62_merge_dup_properties',
  '63_merge_nanjing5_tai4','64_hk_linen_groups','65_fix_sync_order_deposits'
]) x
on conflict (name) do nothing;

select record_migration('70_schema_migrations');


-- ============================================================
-- 驗證
-- ============================================================
select name, to_char(applied_at, 'MM-DD HH24:MI') as 執行時間, source
from public.schema_migrations order by name;

-- 重跑保護：第二次呼叫要回警告而不是報錯
select record_migration('70_schema_migrations') as 重跑結果;

select count(*) filter (where source = 'recorded') as 確實記錄,
       count(*) filter (where source = 'assumed')  as 事後推測
from public.schema_migrations;


-- ── 補記 66~69 ─────────────────────────────────────
-- 66~69 各自結尾都會呼叫 record_migration，但那要 70 先跑過才有效。
-- 若是先跑了 66~69 才跑這支，它們沒被記到 —— 把已經跑過的那幾行取消註解。
-- 沒跑過的**不要**取消註解，寧可沒紀錄也不要有假紀錄。
--
-- select record_migration('66_hk_work_type_consistency');
-- select record_migration('67_hk_audit_trigger');
-- select record_migration('68_hk_drop_is_common');
-- select record_migration('69_hk_staff_source_names');
