-- migration_133：自動長出來的工作改成「建議」，打勾才進行事曆
--
-- ============================================================
-- 【建議，不自動】（2026-08-16 使用者指定）
--
-- `hk_sync_order_tasks()` 從訂單推導退房／入住清潔，直接寫進 `hk_task` ——
-- 也就是**系統自己決定行事曆上有什麼**。
--
-- 問題不是推導錯，是推導對不對沒有人確認過就已經上了牆:
--
--   · 訂單日期改了 → 工作跟著搬，但那天真的要清嗎？
--   · 同一天兩筆訂單 → 兩件清潔，但可能只要清一次
--   · 房源對不到 → 工作根本沒長出來，而牆上看起來很正常
--
-- 改成跟同步建議同一個模式:**系統負責看見，人負責決定。**
-- 自動產生的先當建議，打勾才變成真的工作。
--
--
-- ============================================================
-- 【三個狀態，三種樣子】
--
--   accepted = false ＋ auto_kind 有值   建議。淡色、虛線、有勾選框
--   accepted = true  ＋ staff_id 是 null 已接受、還沒指派。有顏色、虛線邊
--   accepted = true  ＋ staff_id 有值    正常。實心色條
--
-- 全部取消勾選的話行事曆就是白的 —— 那是刻意的:
-- 「這個月還沒排」跟「這個月排好了」要看得出差別。
--
--
-- ============================================================
-- 【既有資料一律視為已接受】
--
-- 設成 false 的話，行事曆會在你推上去的那一刻**整個變空白**，
-- 而幾百筆已經在跑的工作要重新勾一遍。
--
-- 既有的是已經在用的東西，不是待確認的建議。
-- 只有**這支 migration 之後新長出來的**才需要打勾。

alter table public.hk_task
  add column if not exists accepted boolean not null default true;

comment on column public.hk_task.accepted is
  '有沒有被人確認過。自動從訂單長出來的預設 false（建議,要打勾才上行事曆）,'
  '人工新增的直接 true。'
  '既有資料在 migration_133 一律設 true —— 那些是已經在用的,不是待確認的。';

create index if not exists hk_task_pending_idx
  on public.hk_task (work_date) where not accepted;


/*
 * 觸發器產生的新工作預設「未接受」。
 *
 * 只改 insert 的預設值 —— **不動既有列**。
 * 訂單改日期時工作跟著搬，那時 accepted 維持原樣:
 * 已經接受過的搬過去還是接受的，不用再勾一次。
 */
create or replace function public.hk_task_default_accepted() returns trigger
language plpgsql as $fn$
begin
  -- 自動長出來的（auto_kind 有值）預設要人確認；人工加的直接生效
  if new.auto_kind is not null and tg_op = 'INSERT' then
    new.accepted := coalesce(new.accepted, false);
    -- 明確寫 false —— 欄位的 default 是 true（為了既有資料），
    -- 不覆蓋的話自動產生的會直接變成已接受，這支就白做了
    if new.accepted is not false then new.accepted := false; end if;
  end if;
  return new;
end $fn$;

drop trigger if exists trg_hk_task_default_accepted on public.hk_task;
create trigger trg_hk_task_default_accepted
  before insert on public.hk_task
  for each row execute function public.hk_task_default_accepted();

comment on function public.hk_task_default_accepted() is
  '自動長出來的工作預設未接受。'
  '欄位 default 是 true（為了讓既有資料不用回填）,所以這裡要明確蓋成 false —— '
  '不蓋的話自動產生的會直接上行事曆,整支 migration 就白做了。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('133_task_accepted');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk133;
  create temp table _chk133 (ord int, item text, result text, detail text);

  insert into _chk133 values (1, 'hk_task.accepted 欄位',
    case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'hk_task'
                        and column_name = 'accepted') then '✅' else '❌' end, '');

  insert into _chk133 values (1, '預設未接受的觸發器',
    case when exists (select 1 from pg_trigger
                      where tgname = 'trg_hk_task_default_accepted'
                        and not tgisinternal) then '✅' else '❌' end, '');

  select count(*) into n from public.hk_task where accepted;
  insert into _chk133 values (2, '★ 既有工作（視為已接受）', n || ' 筆',
    '行事曆現在看到的跟推之前一樣 —— 這支不會讓月曆變空白');

  select count(*) into n from public.hk_task where not accepted;
  insert into _chk133 values (2, '未接受的', n || ' 筆',
    '應該是 0 —— 這支之後新長出來的才會是未接受');

  /*
   * 實測一次:插一筆自動工作，看它是不是 false。
   *
   * 不測的話「觸發器有沒有真的蓋掉預設值」只能用讀的，
   * 而那正是這支最容易寫錯的地方（欄位 default 是 true）。
   */
  insert into public.hk_task (work_date, work_type, auto_kind)
  values ('1900-01-01', '_自檢', 'checkout');
  select count(*) into n from public.hk_task
   where work_date = '1900-01-01' and not accepted;
  insert into _chk133 values (5, '★★ 自動產生的預設是未接受',
    case when n = 1 then '✅' else '❌ 觸發器沒蓋掉欄位 default' end,
    '欄位 default 是 true,靠觸發器蓋成 false。這一條錯了整支就白做');

  insert into public.hk_task (work_date, work_type) values ('1900-01-01', '_自檢人工');
  select count(*) into n from public.hk_task
   where work_date = '1900-01-01' and work_type = '_自檢人工' and accepted;
  insert into _chk133 values (5, '★ 人工加的直接生效',
    case when n = 1 then '✅' else '❌' end, '人工加的不用自己再勾一次');

  delete from public.hk_task where work_date = '1900-01-01';
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk133 order by ord, item;
