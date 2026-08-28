-- migration_151：補上 expenses.fee_request_id 的唯一索引（跟 150 同一種地雷）
--
-- ============================================================
-- 【為什麼還有一個】
--
-- migration_150 修的是 gen_expenses_from_pr 的
-- `on conflict (source_item_id)`。但那支觸發器最後還會呼叫
-- sync_pr_fee_expense，而它裡面是：
--
--     insert into expenses (... fee_request_id ...) values (...)
--     on conflict (fee_request_id) do update set ...
--
-- 同樣需要一個唯一索引才成立。
--
-- ★ 它還沒被踩到，是因為條件比較窄 —— 只有
--   「匯款 ＋ 手續費不內扣 ＋ 金額 > 0」才會跑到那句。
--   **下一張有手續費的請款單確認出款時就會炸**，
--   而錯誤訊息一模一樣（there is no unique or exclusion constraint…）。
--
-- 這次一起補掉，不要等它發生。
--
--
-- ============================================================
-- 【這個 ON CONFLICT 比 150 那個更關鍵】
--
-- 150 是 `do nothing`（重複就跳過）。
-- 這裡是 `do update`（重複就更新）—— 它是**刻意設計成冪等**的：
--
--   使用者改了手續費金額 → 重新確認 → 同一張單的手續費支出被更新
--   而不是又長出第二筆。
--
-- 沒有索引的話這個冪等性根本不存在，那句話從來沒有生效過。


-- ── 先看有沒有重複 ─────────────────────────────────
do $$
declare n int;
begin
  select count(*) into n from (
    select fee_request_id
      from public.expenses
     where fee_request_id is not null
     group by fee_request_id
    having count(*) > 1
  ) t;

  if n > 0 then
    -- 有重複代表同一張請款單產生了兩筆手續費支出。
    -- 不自動刪 —— 那是帳的問題，要人看過才知道留哪一筆。
    raise exception
      'expenses.fee_request_id 有 % 組重複，索引建不起來。'
      '請先看檔尾的清單，決定每組留哪一筆再重跑。', n;
  end if;
end $$;


-- ── 建索引 ─────────────────────────────────────────
create unique index if not exists expenses_fee_request_uidx
  on public.expenses (fee_request_id);

comment on index public.expenses_fee_request_uidx is
  '一張請款單只能有一筆匯款手續費支出。sync_pr_fee_expense 的 '
  'on conflict (fee_request_id) do update 需要它才成立 —— '
  '沒有它，有手續費的單一按「確認付款日」就會失敗（migration_151）。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('151_expenses_fee_request_unique');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk151;
  create temp table _chk151 (ord int, item text, result text, detail text);

  insert into _chk151 values (1, '★★ 唯一索引',
    case when exists (
      select 1 from pg_indexes
       where schemaname = 'public' and tablename = 'expenses'
         and indexname = 'expenses_fee_request_uidx') then '✅' else '❌' end,
    'ON CONFLICT (fee_request_id) 需要它才成立');

  insert into _chk151 values (2, '★★ 150 的那個還在',
    case when exists (
      select 1 from pg_indexes
       where schemaname = 'public' and tablename = 'expenses'
         and indexname = 'expenses_source_item_uidx') then '✅' else '❌' end,
    '兩個都要有，缺一個就會在不同情境各炸一次');

  select count(*) into n from public.expenses where fee_request_id is not null;
  insert into _chk151 values (3, '既有的手續費支出', n || ' 筆', '每張請款單最多一筆');

  /*
   * ★ 接下來會用到這條路的單:已核可、還沒出款、匯款、手續費不內扣且大於 0。
   *   這些單在補索引之前按「確認付款日」一定會失敗。
   */
  select count(*) into n from public.purchase_requests
   where status = 'approved' and purchased_on is null
     and payment_method = 'transfer' and fee_mode = 'extra'
     and coalesce(fee_amount, 0) > 0;
  insert into _chk151 values (4, '★ 會走到手續費那條路的待出款單', n || ' 張',
    case when n = 0 then '目前沒有 —— 但下一張有手續費的就會用到'
         else '★ 這幾張在補索引之前一定會失敗，現在可以了' end);
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk151 order by ord;


-- ============================================================
-- expenses 上所有的唯一索引 —— 確認沒有第三顆地雷
-- ============================================================
select indexname as "索引", indexdef as "定義"
from pg_indexes
where schemaname = 'public' and tablename = 'expenses'
  and indexdef ilike '%unique%'
order by indexname;


-- ============================================================
-- 如果上面 raise exception 了，看是哪幾組重複
-- ============================================================
select
  e.fee_request_id                    as "請款單",
  count(*)                            as "重複幾筆",
  string_agg(e.id::text, ' / ')       as "支出 id",
  string_agg(e.spent_on::text, ' / ') as "支出日",
  string_agg(e.amount::text, ' / ')   as "金額"
from public.expenses e
where e.fee_request_id is not null
group by e.fee_request_id
having count(*) > 1
order by count(*) desc;
