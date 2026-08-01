-- migration_35：推播通知的裝置訂閱表
--
-- 一個人可以有多台裝置（手機、平板、桌機各一筆），所以是 user 對 subscription 的一對多。
-- endpoint 是瀏覽器給的推播端點，同一台裝置重新訂閱會拿到同一個 endpoint，
-- 因此用它做唯一鍵，重複訂閱時 upsert 而不是長出新列。

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  -- 推播失敗（裝置解除安裝、權限被關）時累計，連續失敗就清掉這筆
  fail_count int not null default 0,
  last_sent_at timestamptz
);

create index if not exists push_sub_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- 每個人只碰得到自己的訂閱。推播發送走 service role，不受 RLS 限制。
drop policy if exists push_own_select on public.push_subscriptions;
create policy push_own_select on public.push_subscriptions
  for select using (user_id = auth.uid());

drop policy if exists push_own_insert on public.push_subscriptions;
create policy push_own_insert on public.push_subscriptions
  for insert with check (user_id = auth.uid());

drop policy if exists push_own_update on public.push_subscriptions;
create policy push_own_update on public.push_subscriptions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists push_own_delete on public.push_subscriptions;
create policy push_own_delete on public.push_subscriptions
  for delete using (user_id = auth.uid());


-- ============================================================
-- 驗證
-- ============================================================
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'push_subscriptions'
order by policyname;
