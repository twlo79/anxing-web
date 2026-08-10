-- migration_103：公告
--
-- ============================================================
-- 【這一張表要解決的問題】
--
-- 公告目前是 LINE 群組。LINE 的問題不是發不出去，是**留不住**：
-- 訊息會被之後的閒聊沖掉，新人看不到三個月前發過的規則，
-- 而且沒有人知道誰看過。「我沒看到」在 LINE 上是無法反駁的。
--
-- 所以這張表只做三件 LINE 做不到的事：
--   1. 一直在那裡（不會被沖掉）
--   2. 置頂（重要的排最上面，不靠時間）
--   3. 已讀（誰看過、什麼時候看的）
--
-- 沒有做留言、標籤、附件 —— 那些會讓公告變成第二個聊天室。
--
--
-- ============================================================
-- 【為什麼已讀是另一張表而不是一個欄位】
--
-- 已讀是「每個人 × 每則公告」的關係，寫在公告那一列上放不下。
-- 而且已讀要能回答「誰還沒看」—— 那需要拿全體員工去 left join，
-- 不是在公告列上存一個計數就能算的。
-- ============================================================

create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null,
  -- 置頂的公告排在最前面,不看日期。
  -- 「颱風天出勤規則」這種東西不該因為過了兩週就沉下去。
  pinned     boolean not null default false,
  -- 下架而不是刪除 —— 公告是講過的話,刪掉之後爭議就沒有證據
  active     boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ann_list_idx
  on public.announcements (pinned desc, created_at desc) where active;

comment on table public.announcements is
  '公告。取代 LINE 群組的原因是留得住、置頂得了、看得到誰讀過 —— '
  '不做留言與附件,那會讓公告變成第二個聊天室。';

create table if not exists public.announcement_reads (
  ann_id  uuid not null references public.announcements(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (ann_id, user_id)
);

comment on table public.announcement_reads is
  '誰在什麼時候看過哪一則公告。「我沒看到」在 LINE 上無法反駁,在這裡可以。';


-- ── 標記已讀 ───────────────────────────────────────
--
-- 用 RPC 而不是讓前端直接 insert：
-- 前端 insert 撞到主鍵重複會回錯誤（409），畫面上會變成紅字，
-- 但「已經讀過的又讀一次」根本不是錯誤。
create or replace function public.mark_announcement_read(p_ann uuid)
returns void
language sql security definer set search_path = public as $fn$
  insert into public.announcement_reads (ann_id, user_id)
  values (p_ann, auth.uid())
  on conflict (ann_id, user_id) do nothing;
$fn$;


-- ── 誰還沒讀 ───────────────────────────────────────
--
-- 主管要看的是「還沒讀的名單」，不是已讀人數。
-- 人數只能告訴你「有人沒讀」，名單才能讓你去敲那個人。
-- SECURITY DEFINER 會繞過 RLS，所以函式自己要檢查角色 ——
-- 不檢查的話任何人都能列出全公司誰沒讀，那是主管才需要的資訊。
-- 這是 SECURITY DEFINER 最常見的漏洞，而它不會有任何症狀。
create or replace function public.announcement_unread(p_ann uuid)
returns table (name text, role text)
language sql stable security definer set search_path = public as $fn$
  select p.name, p.role
    from public.profiles p
   where current_role_of() in ('manager', 'super_admin')
     and coalesce(p.active, true)
     and not exists (
       select 1 from public.announcement_reads r
        where r.ann_id = p_ann and r.user_id = p.id)
   order by p.name;
$fn$;

revoke all on function public.announcement_unread(uuid) from public;
grant execute on function public.announcement_unread(uuid) to authenticated;
revoke all on function public.mark_announcement_read(uuid) from public;
grant execute on function public.mark_announcement_read(uuid) to authenticated;


-- ── RLS ────────────────────────────────────────────

alter table public.announcements enable row level security;

-- 讀：所有人,但下架的只有主管看得到
drop policy if exists ann_read on public.announcements;
create policy ann_read on public.announcements for select
  using (
    (active and current_role_of() is not null)
    or current_role_of() = any (array['manager', 'super_admin'])
  );

drop policy if exists ann_write on public.announcements;
create policy ann_write on public.announcements for all
  using      (current_role_of() = any (array['manager', 'super_admin']))
  with check (current_role_of() = any (array['manager', 'super_admin']));

alter table public.announcement_reads enable row level security;

-- 已讀紀錄：自己的一定看得到,主管看得到全部（要知道誰還沒讀）
drop policy if exists annr_read on public.announcement_reads;
create policy annr_read on public.announcement_reads for select
  using (user_id = auth.uid()
         or current_role_of() = any (array['manager', 'super_admin']));

-- 只能標記自己已讀。不寫這條的話,誰都可以幫別人「已讀」。
drop policy if exists annr_self on public.announcement_reads;
create policy annr_self on public.announcement_reads for insert
  with check (user_id = auth.uid());


-- ── 更新時間 ───────────────────────────────────────
create or replace function public.touch_announcement() returns trigger
language plpgsql as $fn$
begin new.updated_at := now(); return new; end $fn$;

drop trigger if exists trg_ann_touch on public.announcements;
create trigger trg_ann_touch before update on public.announcements
  for each row execute function public.touch_announcement();


-- ── 確認 ───────────────────────────────────────────
select
  (select count(*) from public.announcements)                          as "公告數",
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'announcements')       as "公告政策數",
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'announcement_reads')  as "已讀政策數",
  case when to_regprocedure('public.mark_announcement_read(uuid)') is not null
       then '✓' else '❌ 缺 mark_announcement_read' end                 as "標記已讀",
  case when to_regprocedure('public.announcement_unread(uuid)') is not null
       then '✓' else '❌ 缺 announcement_unread' end                    as "未讀名單";


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('103_announcements'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
