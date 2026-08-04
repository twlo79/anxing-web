-- migration_71：同步狀態表
--
-- 【問題】
-- 評價同步的「撤評哨兵」把狀態存在本機檔 sync-backups/sync-state.json：
--   { reviewsTotal, topReviewId, lastFullReconcile }
--
-- 那個檔只存在於**跑同步的那一台機器上**。專案路徑已經從
-- C:\Users\1993\projects 換到 C:\Users\ASUS\Desktop，那份狀態大概早就對不上了。
--
-- 對不上的後果不是報錯，是**每天都強制跑全量對帳** ——
-- 哨兵邏輯的第 3 條寫著「找不到 topReviewId → 強制全量對帳」，
-- 而換機器的症狀跟「一天新增超過 50 筆」長得一模一樣。
-- 30 次請求跑一分鐘，每天，沒人會發現。
--
-- 狀態放 DB 就沒這個問題：換機器、換使用者、同時兩台跑，都對得起來。

create table if not exists public.sync_state (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

comment on table public.sync_state is
  '排程同步的狀態。刻意不放本機檔 —— 那會綁死在某一台機器上，'
  '換機器時症狀是「靜靜地每天多跑一次全量對帳」，不會有人發現。';

alter table public.sync_state enable row level security;

drop policy if exists sync_state_read on public.sync_state;
create policy sync_state_read on public.sync_state
  for select using (auth.role() = 'authenticated');
-- 寫入只走 service key（API 端點），前端不需要改它

create or replace function public.set_sync_state(p_key text, p_value jsonb)
returns void language sql security definer set search_path = public as $$
  insert into sync_state (key, value, updated_at) values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
$$;

-- 從既有的本機檔搬過來，銜接得上就不會白跑一次全量對帳
insert into public.sync_state (key, value)
values ('reviews', '{"lastFullReconcile": "2026-07-30"}'::jsonb)
on conflict (key) do nothing;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare v jsonb;
begin
  perform set_sync_state('__test__', '{"a": 1}'::jsonb);
  select value into v from sync_state where key = '__test__';
  if v is null or v->>'a' <> '1' then raise exception 'set_sync_state 沒寫進去'; end if;

  perform set_sync_state('__test__', '{"a": 2}'::jsonb);
  select value into v from sync_state where key = '__test__';
  if v->>'a' <> '2' then raise exception 'set_sync_state 沒有覆蓋既有值'; end if;

  delete from sync_state where key = '__test__';
  raise notice 'set_sync_state 正常';
end $$;

select key, value, updated_at from public.sync_state;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('71_sync_state'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
