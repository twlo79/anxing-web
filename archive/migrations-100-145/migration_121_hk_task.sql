-- migration_121：房務工作（從訂單自動長出來，可以手動增刪）
--
-- ============================================================
-- 【要解決什麼】
--
-- 排班現在靠 TimeTree：人在日曆上打「退-A3-Ariel Wang」，
-- 每月匯進 ERP 再用字串解析拆成工作項。
--
-- 那條路有三個問題，而三個都不會報錯：
--
--   1. **打字就會錯**。房源寫法沒有統一（A3 / A-3 / 開封2F / 開封2樓），
--      解析不到的就靜靜掉了 —— 那間房那天就沒有人去打掃。
--   2. **訂單改了日期，行事曆不會知道**。延住兩晚，清潔還排在舊日期，
--      而房間到那天其實還有人住。
--   3. **要重打一次**。進退房日期訂單上明明就有。
--
-- ERP 已經有訂單的 checkin / checkout，所以「哪天哪間要清」是
-- **算得出來的**，不用人建。
--
--
-- ============================================================
-- 【設計：自動長出來，但可以手動增刪】（使用者選擇）
--
--   退房日 → 退房清潔        自動，跟著訂單走
--   入住日 → 入住清潔        自動，跟著訂單走
--   公區清潔、細清、點交…     手動加
--
-- 自動的那些由觸發器維護：訂單改日期，工作跟著搬；訂單取消，工作跟著消失。
--
-- **但指派給誰會保留。** 延住兩晚、清潔日往後移，負責的還是同一個人 ——
-- 每次改日期都要重新指派的話，這個功能不會有人用。
--
--
-- ============================================================
-- 【為什麼房源用 properties 而不是 hk_property】（使用者指定）
--
-- 現在有兩份房源名單：`properties`（訂單、營收、評價在用）與
-- `hk_property`（房務自己的，靠 code 與 aliases 比對 TimeTree 的字串）。
--
-- 兩份名單就是兩個真相。新增一間房要記得建兩次，而漏建那一次的症狀是
-- 「排班統計少一間」—— 沒有人會發現一個本來就不太看的數字少了一格。
--
-- 房務專屬的資料（幾床、布巾群組）搬到 properties 上，名單只留一份。
-- hk_property 暫時保留給 TimeTree 匯入用，等停用之後再移除。

-- ============================================================
-- 一、房源補上房務要用的欄位
-- ============================================================
alter table public.properties
  add column if not exists beds int,
  add column if not exists linen_group text not null default 'other'
    check (linen_group in ('kai', 'ab', 'zl', 'other')),
  /**
   * 房源類型。跟 hk_property.ptype 同一套值。
   *
   * 【為什麼不是 is_common 一個布林】
   * hk_property 當初兩個都有（is_common ＋ ptype），同一件事兩個欄位在表達，
   * 而下一個人不知道該信哪一個 —— migration_68 就是為了收掉那個矛盾。
   * 這裡直接用收斂後的那一個。
   */
  add column if not exists ptype text not null default 'room'
    check (ptype in ('room', 'building', 'common_area', 'other')),
  /** 這個房源算不算布巾。公區、整棟通常不算 */
  add column if not exists count_linen boolean not null default true;

comment on column public.properties.beds is
  '幾張床。布巾組數 = 床數 × 打掃次數。null = 還沒建檔（公區是 0）。';

-- 從 hk_property 帶過來，名稱對得上的才帶
do $$ begin
  if to_regclass('public.hk_property') is not null then
    update public.properties p
       set beds        = coalesce(p.beds, h.beds),
           linen_group = case when p.linen_group = 'other' then h.linen_group else p.linen_group end,
           ptype       = case when p.ptype = 'room' then h.ptype else p.ptype end,
           count_linen = p.count_linen and h.count_linen
      from public.hk_property h
     where h.code = p.name or p.name = any(h.aliases);
  end if;
end $$;


-- ============================================================
-- 二、房務工作
-- ============================================================
create table if not exists public.hk_task (
  id          uuid primary key default gen_random_uuid(),
  work_date   date not null,
  /** ERP 房源。null = 沒有房源的工作（洗烘折毛巾、協助行政） */
  property_id uuid references public.properties(id) on delete set null,
  work_type   text not null default '清潔',
  /** 指派給誰。null = 還沒指派 —— 那正是行事曆上要看到的東西 */
  staff_id    uuid references public.staff(id) on delete set null,

  /**
   * 這筆是從哪一張訂單長出來的。
   * null = 人工加的（公區清潔、細清、點交…）。
   */
  order_id    uuid references public.orders(id) on delete cascade,
  /** 'checkout' 退房清潔 / 'checkin' 入住清潔。人工加的是 null。 */
  auto_kind   text check (auto_kind in ('checkout', 'checkin')),

  note        text,
  /** 做完了。房務自己按，或主管代按。 */
  done_at     timestamptz,
  created_at  timestamptz not null default now(),
  created_by  uuid
);

/*
 * 一張訂單的一種自動工作只會有一筆。
 *
 * 沒有這道鎖的話，訂單每改一次日期就多一筆 —— 而多出來的那筆
 * 停在舊日期上，看起來就像「那天真的有工作」。
 */
create unique index if not exists uq_hk_task_auto
  on public.hk_task (order_id, auto_kind)
  where order_id is not null and auto_kind is not null;

create index if not exists idx_hk_task_date  on public.hk_task (work_date);
create index if not exists idx_hk_task_staff on public.hk_task (staff_id, work_date);

comment on table public.hk_task is
  '房務工作。退房/入住清潔由訂單自動長出來（觸發器維護），'
  '公區清潔等由人工加。改訂單日期時工作跟著搬，但指派保留。';


-- ── 權限 ───────────────────────────────────────────
alter table public.hk_task enable row level security;

/*
 * 全員可讀。排班本來就是要互相配合的資訊：
 * 今天誰在哪一棟、誰可以幫忙、誰休假。
 * 跟 migration_110 的房務行事曆同一個立場。
 */
drop policy if exists hk_task_read on public.hk_task;
create policy hk_task_read on public.hk_task
  for select using (auth.role() = 'authenticated');

/** 排班是主管的事 —— 讓被指派的人自己改，那個班表就不再是安排而是協商 */
drop policy if exists hk_task_write on public.hk_task;
create policy hk_task_write on public.hk_task
  for all using      (current_role_of() in ('manager', 'super_admin'))
         with check  (current_role_of() in ('manager', 'super_admin'));


-- ============================================================
-- 三、從訂單長出來
-- ============================================================
--
-- 【哪些訂單算數】
--
-- 只有**短租的一段住宿**才有進退房清潔：
--
--   排除 契約月租單     一份契約一次生 24 筆，每筆的起訖是「這個月」，
--                       不是實際進退房 —— 會產生 24 次退房清潔，全是錯的
--   排除 定期收費       洗衣機、垃圾代收費，根本沒有人住
--   排除 加費子單       跟母單同房同日期，會變成兩次清潔
--   排除 移房拆段？     **不排除** —— 移房是真的換房間，兩邊都要清
--   排除 已作廢的取消單 沒有人來，不用清
--
-- 這組條件跟 lib/audit-orders 的 isStay 是同一個概念。
create or replace function public.hk_order_is_stay(o public.orders) returns boolean
language sql immutable as $fn$
  select o.checkin is not null
     and o.checkout is not null
     and o.checkout > o.checkin
     and coalesce(o.source, '') not in ('oneoff', 'airbnb_cancelled')
     and o.parent_order_id is null
     and coalesce(o.imported_via, '') not in ('contract', 'recurring')
$fn$;


create or replace function public.hk_sync_order_tasks() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_prop uuid;
begin
  if tg_op = 'DELETE' then
    -- FK 是 on delete cascade，這裡不用做事
    return old;
  end if;

  if not hk_order_is_stay(new) then
    -- 從「算數」變成「不算數」（取消、改成一次性收入）→ 把自動工作收掉。
    -- **已經做完的留著** —— 那是已經發生的事實，不該因為訂單狀態變了就消失
    delete from hk_task
     where order_id = new.id and auto_kind is not null and done_at is null;
    return new;
  end if;

  v_prop := new.property_id;

  /*
   * upsert：日期改了就搬，**指派保留**。
   *
   * 延住兩晚、清潔日往後移，負責的還是同一個人 ——
   * 每次改日期都要重新指派的話，這個功能不會有人用。
   */
  insert into hk_task (work_date, property_id, work_type, order_id, auto_kind)
  values (new.checkout, v_prop, '退房清潔', new.id, 'checkout')
  on conflict (order_id, auto_kind) where order_id is not null and auto_kind is not null
  do update set work_date = excluded.work_date, property_id = excluded.property_id;

  insert into hk_task (work_date, property_id, work_type, order_id, auto_kind)
  values (new.checkin, v_prop, '入住清潔', new.id, 'checkin')
  on conflict (order_id, auto_kind) where order_id is not null and auto_kind is not null
  do update set work_date = excluded.work_date, property_id = excluded.property_id;

  return new;
end $fn$;

drop trigger if exists trg_hk_sync_order_tasks on public.orders;
create trigger trg_hk_sync_order_tasks
  after insert or update of checkin, checkout, property_id, source, imported_via
  on public.orders
  for each row execute function public.hk_sync_order_tasks();


-- ============================================================
-- 四、回填（只補未來與最近，不動歷史）
-- ============================================================
--
-- 【為什麼不全部回填】
-- 歷史的清潔已經做完了，補出來的是一整年沒有人指派、也不會有人去按的
-- 待辦 —— 那會讓行事曆一打開就是幾千筆灰色的空工作，
-- 而真正要看的這個月被埋在裡面。
--
-- 只補「今天之後」與「最近 30 天」：前者是要排的，後者是可能還沒清完的。
insert into public.hk_task (work_date, property_id, work_type, order_id, auto_kind)
select o.checkout, o.property_id, '退房清潔', o.id, 'checkout'
  from public.orders o
 where public.hk_order_is_stay(o)
   and o.checkout >= current_date - 30
on conflict (order_id, auto_kind) where order_id is not null and auto_kind is not null
do nothing;

insert into public.hk_task (work_date, property_id, work_type, order_id, auto_kind)
select o.checkin, o.property_id, '入住清潔', o.id, 'checkin'
  from public.orders o
 where public.hk_order_is_stay(o)
   and o.checkin >= current_date - 30
on conflict (order_id, auto_kind) where order_id is not null and auto_kind is not null
do nothing;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('121_hk_task');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare
  v_est uuid; v_prop uuid; v_staff uuid; v_ord uuid; n int; d date;
begin
  drop table if exists _chk121;
  create temp table _chk121 (ord int, item text, result text, detail text);

  insert into _chk121 values (1, 'hk_task 表',
    case when to_regclass('public.hk_task') is not null then '✅' else '❌' end, '');
  /*
   * 【一定要帶 table_schema】
   * `properties` 這個名字在 Supabase 的其他 schema 裡也有，
   * 不篩 schema 的話 count 會超過 4，然後這個檢查會回一個
   * 看起來很嚴重但完全錯誤的 ❌ —— 而人會去查一個根本不存在的問題。
   */
  insert into _chk121 values (1, 'properties 補上房務欄位',
    case when (select count(*) from information_schema.columns
               where table_schema = 'public' and table_name = 'properties'
                 and column_name in ('beds', 'linen_group', 'ptype', 'count_linen')) = 4
         then '✅' else '❌' end, '房源名單只留一份 —— 兩份就是兩個真相');

  select id into v_est from public.estates limit 1;
  select id into v_staff from public.staff limit 1;

  delete from public.orders where order_key = '__T121__';
  delete from public.properties where name = '__T121房__';
  insert into public.properties (name, estate_id, beds) values ('__T121房__', v_est, 2)
  returning id into v_prop;

  -- 建一張短租訂單 → 應該自動長出兩筆工作
  insert into public.orders
    (order_key, source, estate_id, property_id, property_raw, guest_name,
     checkin, checkout, nights, amount, imported_via)
  values ('__T121__', 'airbnb', v_est, v_prop, '__T121房__', '測試',
          '2026-09-01', '2026-09-05', 4, 20000, 'auto')
  returning id into v_ord;

  select count(*) into n from public.hk_task where order_id = v_ord;
  insert into _chk121 values (2, '★★ 訂單一建立就長出退房與入住清潔',
    case when n = 2 then '✅' else '❌ ' || n || ' 筆' end,
    '進退房日期訂單上明明就有,不該再叫人去日曆打一次');

  -- 指派給某人，然後改日期 → 日期要搬，指派要留
  update public.hk_task set staff_id = v_staff
   where order_id = v_ord and auto_kind = 'checkout';
  update public.orders set checkout = '2026-09-07' where id = v_ord;

  select work_date, staff_id into d, v_staff
    from public.hk_task where order_id = v_ord and auto_kind = 'checkout';

  insert into _chk121 values (3, '★★ 改日期時工作跟著搬',
    case when d = '2026-09-07' then '✅' else '❌ ' || coalesce(d::text, 'null') end,
    '延住兩晚而清潔還排在舊日期的話,那天房間其實還有人住');

  insert into _chk121 values (4, '★★ 搬了但指派要保留',
    case when v_staff is not null then '✅' else '❌ 被清掉了' end,
    '每次改日期都要重新指派的話,這個功能不會有人用');

  -- 訂單取消 → 未完成的自動工作要收掉
  update public.orders set source = 'airbnb_cancelled' where id = v_ord;
  select count(*) into n from public.hk_task where order_id = v_ord and done_at is null;
  insert into _chk121 values (5, '★ 訂單取消,還沒做的工作要消失',
    case when n = 0 then '✅' else '❌ 還剩 ' || n end,
    '沒有人來就不用清。已經做完的會留著 —— 那是已經發生的事實');

  delete from public.orders where id = v_ord;
  delete from public.properties where id = v_prop;

  select count(*) into n from public.hk_task;
  insert into _chk121 values (6, '回填出來的工作', n || ' 筆',
    '只補今天前後 30 天 —— 全部回填的話行事曆一打開是幾千筆沒人會處理的灰色待辦');

  select count(*) into n from public.properties where beds is null and active;
  insert into _chk121 values (7, '★ 還沒填床數的房源',
    case when n = 0 then '✅ 都有了' else '⚠ ' || n || ' 間' end,
    '布巾組數 = 床數 × 打掃次數。沒填的話那間房算不出要帶幾組');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk121 order by ord, item;
