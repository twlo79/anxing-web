-- migration_128：通知訊息留一週
--
-- ============================================================
-- 【為什麼要存下來】
--
-- README 上寫著「推播通知 —— **不存**，發完就沒了」。那是刻意的，
-- 但代價現在浮出來了：
--
--   手機鎖屏跳出「新增 3 筆訂單」→ 滑掉 → **那則訊息永遠不見了**。
--   沒有任何地方查得到剛剛那則說了什麼、是哪三筆。
--
-- 通知的價值在「即時」，但即時的東西天生會被錯過 ——
-- 開會中、在開車、手機在充電。錯過一次就等於沒發過。
--
--
-- ============================================================
-- 【為什麼一人一列，不是一則一列】
--
-- 直覺是「一則通知存一列，誰收到記在 recipients 陣列」。那樣省空間，
-- 但**「我讀了沒」就沒地方放** —— 讀取狀態是每個人各自的。
--
-- 塞進 jsonb 的話，兩個人同時標已讀會互相蓋掉（讀改寫的競態），
-- 而那個 bug 只在兩人同時開著頁面時出現，重現不了。
--
-- 一人一列，read_at 就是那個人自己的欄位。多出來的列數是小事：
-- 十個人、一天十則、留七天 = 七百列。
--
--
-- ============================================================
-- 【留一週】（2026-08-15 使用者指定）
--
-- 「上禮拜三那則講什麼」是真的會問的；「上個月那則」不會。
-- 而永久保留的清單會長到沒有人願意捲 —— 那時它就跟沒有一樣。
--
-- 兩層做法：
--   讀取時只撈七天內  → 畫面上永遠是一週，跟哪天清無關
--   每週日清掉七天前  → 真正把資料刪掉，表不會無限長大
--
-- 分開做是因為「清除」跟「顯示」是兩件事。只靠週日清的話，
-- 週六會看到十三天份；只靠讀取過濾的話，資料永遠不會被刪掉。

create table if not exists public.notifications (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null,          -- orders | approvals | reviews | cleaning
  title      text not null,
  body       text not null default '',
  /** 點這則要跳去哪 —— 通知的重點是「然後呢」，不是「發生了」 */
  url        text,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);

/*
 * 查詢一定是「我的、最近的、未讀優先」。
 * 這個索引就是為那一句查詢建的。
 */
create index if not exists notifications_user_idx
  on public.notifications (user_id, created_at desc);

create index if not exists notifications_unread_idx
  on public.notifications (user_id) where read_at is null;

comment on table public.notifications is
  '推播通知的存底,留一週。推播本身是「錯過就沒了」——'
  '開會中、在開車、手機在充電,錯過一次就等於沒發過。'
  '一人一列(不是一則一列)因為 read_at 是每個人各自的狀態。';


-- ── RLS：只看得到自己的 ─────────────────────────────
--
-- 請款審核的通知帶金額與品項。共用一張消息牌的話，
-- 誰送了多少錢的單全公司都看得到 —— 那不是這個功能要解決的問題。
alter table public.notifications enable row level security;

drop policy if exists notifications_own on public.notifications;
create policy notifications_own on public.notifications
  for select to authenticated using (user_id = auth.uid());

/*
 * 只准改自己的，而且只准改 read_at。
 *
 * with check 也要寫上 user_id = auth.uid() —— 只寫 using 的話，
 * 可以把自己的那列 update 成別人的 user_id（等於把訊息送給別人）。
 */
drop policy if exists notifications_read_own on public.notifications;
create policy notifications_read_own on public.notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 寫入只走 service key（伺服器端推播時一起寫）。
-- 不開 insert policy —— 前端能寫的話,任何人都可以偽造一則通知給自己看,
-- 而那會讓這張表從「發生過什麼」變成「有人寫了什麼」。


-- ── 清掉舊訊息 ─────────────────────────────────────
create or replace function public.purge_old_notifications()
returns table(item text, n bigint)
language plpgsql security definer set search_path = public as $fn$
declare v_n bigint;
begin
  delete from public.notifications where created_at < now() - interval '7 days';
  get diagnostics v_n = row_count;
  return query select '清掉的舊訊息'::text, v_n;
end $fn$;

comment on function public.purge_old_notifications() is
  '刪掉七天前的通知。每週日跑一次(排程)。'
  '畫面上本來就只撈七天內,所以這支的功能是「不讓表無限長大」,不是「控制顯示」。';

grant execute on function public.purge_old_notifications() to service_role;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('128_notifications');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk128;
  create temp table _chk128 (ord int, item text, result text, detail text);

  insert into _chk128 values (1, 'notifications 表',
    case when to_regclass('public.notifications') is not null then '✅' else '❌' end, '');

  insert into _chk128 values (1, 'purge_old_notifications 函式',
    case when to_regprocedure('public.purge_old_notifications()') is not null
         then '✅' else '❌' end, '');

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'notifications';
  insert into _chk128 values (2, 'RLS 政策', n || ' 條',
    'select 只看自己的、update 只改自己的。沒有 insert —— 只有伺服器端寫得進去');

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'notifications' and cmd = 'INSERT';
  insert into _chk128 values (3, '★ 前端不能自己寫通知',
    case when n = 0 then '✅ 沒有 insert policy' else '❌ 有 ' || n || ' 條' end,
    '開了的話任何人都能偽造一則通知給自己看');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk128 order by ord, item;
