-- migration_152：清掉重複的索引，並記錄真正的成因
--
-- ============================================================
-- 【先更正 migration_150 的診斷 —— 它是錯的】
--
-- 150 說「expenses.source_item_id 沒有唯一索引」。**不對。**
-- 那張表上本來就有 `expenses_source_item_id_key`（一般唯一索引），
-- 所以 gen_expenses_from_pr 的 `on conflict (source_item_id)` 一直是好的。
--
-- 150 建的 `expenses_source_item_uidx` 是多餘的第二顆。
--
--
-- ============================================================
-- 【真正的成因：ON CONFLICT 推斷不到「部分索引」】
--
-- 炸的是 sync_pr_fee_expense 那一段：
--
--     on conflict (fee_request_id) do update set ...
--
-- 而 fee_request_id 上原本只有：
--
--     uq_expense_fee_request  ... WHERE (fee_request_id IS NOT NULL)
--
-- **帶 WHERE 的部分索引，ON CONFLICT 推斷不到** ——
-- 除非那句 insert 自己也寫一模一樣的 WHERE。
-- Postgres 的錯誤訊息只說「找不到匹配的唯一約束」，
-- 不會告訴你「有一顆但它是部分索引」，所以看起來像索引根本不存在。
--
-- migration_151 建的一般唯一索引 `expenses_fee_request_uidx`
-- 讓推斷成立 —— **那顆才是真正修好問題的**。
--
-- 為什麼只有匯款單會炸:sync_pr_fee_expense 只在
-- 「匯款 ＋ 手續費不內扣 ＋ 金額 > 0」時才跑到那句。
-- 其他付款方式走不到，所以這個 bug 藏了很久。
--
--
-- ============================================================
-- 【這支要做什麼】
--
-- 兩對重複的索引各留一顆:
--
--   source_item_id  留 expenses_source_item_id_key（原有，可能背著約束）
--                   刪 expenses_source_item_uidx（150 建的，多餘）
--
--   fee_request_id  留 expenses_fee_request_uidx（151 建的一般索引，ON CONFLICT 靠它）
--                   刪 uq_expense_fee_request（部分索引，推斷不到，留著只是浪費寫入）
--
-- 重複索引不會讓查詢出錯，但每次寫入都要多維護一份，
-- 而且下一個看到這張表的人得先搞懂為什麼同一欄有兩顆。


-- ── source_item_id：刪掉我多建的那顆 ────────────────
do $$
begin
  /*
   * ★ 只有在原本那顆確定還在的時候才刪 —— 順序反了會讓這一欄
   *   有一瞬間沒有唯一保護，而那正是重複支出鑽進來的空隙。
   */
  if exists (select 1 from pg_indexes
              where schemaname = 'public' and tablename = 'expenses'
                and indexname = 'expenses_source_item_id_key')
     and exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'expenses'
                    and indexname = 'expenses_source_item_uidx')
  then
    drop index if exists public.expenses_source_item_uidx;
    raise notice '已刪除多餘的 expenses_source_item_uidx（原有的 _key 保留）';
  else
    raise notice '略過 —— 原有索引不在，或多餘那顆已經沒了';
  end if;
end $$;


-- ── fee_request_id：刪掉推斷不到的部分索引 ──────────
do $$
begin
  /*
   * 反過來:留一般索引、刪部分索引。
   *
   * 一般唯一索引在「防重複」上跟部分索引等效
   * （Postgres 的唯一索引允許多個 NULL），
   * 但它**推斷得到** —— 那是這次整件事的重點。
   */
  if exists (select 1 from pg_indexes
              where schemaname = 'public' and tablename = 'expenses'
                and indexname = 'expenses_fee_request_uidx')
     and exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'expenses'
                    and indexname = 'uq_expense_fee_request')
  then
    drop index if exists public.uq_expense_fee_request;
    raise notice '已刪除部分索引 uq_expense_fee_request（ON CONFLICT 推斷不到它）';
  else
    raise notice '略過 —— 一般索引不在，或部分索引已經沒了';
  end if;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('152_dedupe_expense_indexes');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk152;
  create temp table _chk152 (ord int, item text, result text, detail text);

  /*
   * ★★ 每一欄都必須「剛好一顆」唯一索引，而且不是部分索引。
   *
   *   0 顆 → ON CONFLICT 會炸，就是這次的原始症狀
   *   2 顆 → 多餘，每次寫入多維護一份
   *   部分索引 → 存在但推斷不到 —— **最難查的那種**，
   *              因為錯誤訊息說「找不到」而你看得到它躺在那裡
   */
  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'expenses'
     and indexdef ilike '%unique%' and indexdef ilike '%(source_item_id)%';
  insert into _chk152 values (1, '★★ source_item_id 的唯一索引', n || ' 顆',
    case when n = 1 then '✅ 剛好一顆' else '★ 應該剛好一顆' end);

  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'expenses'
     and indexdef ilike '%unique%' and indexdef ilike '%fee_request_id%';
  insert into _chk152 values (2, '★★ fee_request_id 的唯一索引', n || ' 顆',
    case when n = 1 then '✅ 剛好一顆' else '★ 應該剛好一顆' end);

  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'expenses'
     and indexdef ilike '%unique%' and indexdef ilike '%where%';
  insert into _chk152 values (3, '★★ 還有幾顆部分唯一索引', n || ' 顆',
    case when n = 0 then '✅ 沒有 —— ON CONFLICT 都推斷得到'
         else '★ 有部分索引,確認沒有 ON CONFLICT 指著它' end);
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk152 order by ord;


-- 最後再列一次，人眼確認
select indexname as "索引", indexdef as "定義"
from pg_indexes
where schemaname = 'public' and tablename = 'expenses'
  and indexdef ilike '%unique%'
order by indexname;
