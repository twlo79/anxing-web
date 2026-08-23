-- migration_134：房務工作加標題與時間（照 TimeTree）
--
-- ============================================================
-- 【為什麼要加時間】（2026-08-16 使用者指定：完全照 TimeTree）
--
-- TimeTree 的事件有開始／結束時間與「全天」開關。房務排班實際上也需要:
--
--   退房清潔要等房客走（11:00 之後）
--   入住清潔要在入住前完成（15:00 之前）
--   同一個人一天三間，順序決定他來不來得及
--
-- 現在只有 `work_date`，那三件事在畫面上分不出先後。
--
--
-- ============================================================
-- 【用 time 不用 timestamptz】
--
-- `work_date` 已經是台北的日期。再存一個帶時區的時間點,
-- 兩個欄位就有兩套時區規則 —— 而跨日的那幾筆會開始互相矛盾。
--
-- `time` 型別存「當天的幾點幾分」,配合 `work_date` 就是完整的時間，
-- 而且**不需要任何時區轉換**。
--
-- 跨夜的工作（22:00–02:00）用 `end_time < start_time` 表示，
-- 前端算時長時要 +24 小時 —— 那條規則寫在 lib/hk-task.ts，有測試。
--
--
-- ============================================================
-- 【全天是預設，不是例外】
--
-- 現有的幾百筆工作都沒有時間，而「沒填時間」跟「是全天工作」
-- 在資料上長得一樣。`all_day` 預設 true，既有資料不用回填。
--
-- 填了時間才把 all_day 關掉 —— 那是使用者的動作，不是系統推的。
--
--
-- ============================================================
-- 【標題選填，不取代自動組的那一行】
--
-- 現在畫面上是 `工作類型 房源・客人` 組出來的（lib/hk-task.taskLabel）。
-- 那個組法對絕大多數工作都夠用。
--
-- `title` 是給例外用的:「聚餐」「洗烘折毛巾」「14B1繼續收尾」——
-- TimeTree 上那些本來就是自由文字。有填就顯示它，沒填就用組的。
--
-- 不把 title 設成必填的理由:自動長出來的工作沒有人會去填標題，
-- 而必填會讓那幾百筆全部顯示空白。

alter table public.hk_task
  add column if not exists all_day    boolean not null default true,
  add column if not exists start_time time,
  add column if not exists end_time   time,
  add column if not exists title      text;

comment on column public.hk_task.all_day is
  '全天工作。預設 true —— 既有資料沒有時間,不用回填。'
  '填了時間才由前端關掉。';
comment on column public.hk_task.start_time is
  '當天的開始時間（台北）。work_date 已經是日期,這裡只存時分 —— '
  '存 timestamptz 的話兩個欄位會有兩套時區規則,跨日那幾筆開始互相矛盾。';
comment on column public.hk_task.end_time is
  '結束時間。**小於 start_time 代表跨夜**（22:00–02:00）,'
  '算時長要 +24 小時。規則在 lib/hk-task.ts,有測試釘住。';
comment on column public.hk_task.title is
  '自訂標題。選填 —— 沒填就用「工作類型 房源・客人」組出來的（taskLabel）。'
  '給「聚餐」「洗烘折毛巾」這種例外用,自動長出來的工作不會有。';

/*
 * 【為什麼不加 CHECK 約束】
 *
 * 直覺是「all_day = true 時 start_time 必須是 null」。不加,因為:
 *
 * 使用者切成全天再切回來的時候，時間會留著 —— 那是對的行為
 * （他只是切過去看一下）。約束會逼前端在每次切換時清空，
 * 而清空之後切回來時間就沒了，他要重打一次。
 *
 * all_day 為 true 時**忽略**時間，不是禁止它存在。
 */

create index if not exists hk_task_time_idx
  on public.hk_task (work_date, start_time nulls first);


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('134_task_time');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk134;
  create temp table _chk134 (ord int, item text, result text, detail text);

  insert into _chk134
  select 1, 'hk_task.' || c, case when exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'hk_task' and column_name = c)
    then '✅' else '❌' end, ''
  from unnest(array['all_day', 'start_time', 'end_time', 'title']) c;

  select count(*) into n from public.hk_task where all_day;
  insert into _chk134 values (2, '★ 既有工作（全天）', n || ' 筆',
    '沒有時間的一律是全天 —— 這支不用回填,畫面也不會變');

  select count(*) into n from public.hk_task where not all_day;
  insert into _chk134 values (2, '有指定時間的', n || ' 筆', '應該是 0,之後才會有');

  -- 實測一次跨夜的存不存得進去
  insert into public.hk_task (work_date, work_type, all_day, start_time, end_time, title)
  values ('1900-01-02', '_自檢', false, '22:00', '02:00', '跨夜測試');
  select count(*) into n from public.hk_task
   where work_date = '1900-01-02' and end_time < start_time;
  insert into _chk134 values (5, '★★ 跨夜（22:00–02:00）存得進去',
    case when n = 1 then '✅' else '❌' end,
    '沒有 CHECK 擋 end < start —— 那是跨夜,不是錯誤。時長由前端 +24 小時算');
  delete from public.hk_task where work_date = '1900-01-02';
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk134 order by ord, item;
