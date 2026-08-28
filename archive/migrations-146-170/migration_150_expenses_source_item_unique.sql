-- migration_150：補上 expenses.source_item_id 的唯一索引
--
-- ============================================================
-- 【症狀】（2026-08-19）
--
-- 按「確認付款日」時：
--
--     儲存失敗：there is no unique or exclusion constraint
--               matching the ON CONFLICT specification
--
-- 主管、會計、總管理員都一樣 —— **跟權限無關**。
-- （查了很久才問出這句話，因為那個訊息原本印在彈窗後面，
--   使用者看到的是「按了沒反應」。訊息看得見之後一秒就定位了。）
--
--
-- ============================================================
-- 【為什麼】
--
-- gen_expenses_from_pr 產生支出時寫：
--
--     insert into public.expenses (...) select ... from purchase_request_items i
--      where i.request_id = new.id
--     on conflict (source_item_id) do nothing;
--
-- Postgres 的 `ON CONFLICT (欄位)` 需要一個**能推斷得到的唯一索引**。
-- expenses.source_item_id 上沒有 —— 所以那句 insert 直接噴錯，
-- 而它在 BEFORE 觸發器裡，整個 UPDATE 一起回滾。
--
-- 結果是「確認付款日」對任何角色都不可能成功。
--
--
-- ============================================================
-- 【為什麼是「補索引」而不是「拿掉 ON CONFLICT」】
--
-- 那句 `do nothing` 是在防**重複產生支出**：
-- 一張請款單的每個項目只該對到一筆支出。
--
-- 拿掉它的話，任何重跑（重試、並發、將來有人手動再觸發一次）
-- 都會讓同一個項目產生第二筆支出 —— 而**支出是錢的最終紀錄**，
-- 多一筆就是帳上憑空多一筆花費，還會被算進營收報表。
--
-- 索引補上去之後那個保護才是真的。現在等於「寫了防呆但它從來沒生效過」。
--
--
-- ============================================================
-- 【為什麼用一般唯一索引而不是部分索引】
--
-- source_item_id 是可空的（手動建立的支出沒有來源項目）。
-- Postgres 的唯一索引**允許多個 NULL**，所以手動支出不受影響。
--
-- 不用 `where source_item_id is not null` 的部分索引，是因為
-- `ON CONFLICT (source_item_id)` 要推斷到部分索引時，
-- 語句本身也得帶一模一樣的 WHERE —— 那就得同時改觸發器，
-- 而觸發器是對的，不該為了索引的寫法去動它。


-- ── 先看有沒有重複（有的話索引建不起來）─────────────
do $$
declare n int;
begin
  select count(*) into n from (
    select source_item_id
      from public.expenses
     where source_item_id is not null
     group by source_item_id
    having count(*) > 1
  ) t;

  if n > 0 then
    /*
     * ★ 有重複就停下來，不要自作主張刪。
     *
     * 重複代表同一個請款項目產生了兩筆支出 —— 那是帳的問題，
     * 要人看過才知道該留哪一筆（金額可能被改過、可能已經認列）。
     * migration 直接刪掉的話，錢的紀錄會在沒有人知道的情況下消失。
     */
    raise exception
      'expenses.source_item_id 有 % 組重複，索引建不起來。'
      '請先看檔尾那段查詢列出的清單，決定每組留哪一筆再重跑這支。', n;
  end if;
end $$;


-- ── 建索引 ─────────────────────────────────────────
create unique index if not exists expenses_source_item_uidx
  on public.expenses (source_item_id);

comment on index public.expenses_source_item_uidx is
  '一個請款項目只能產生一筆支出。gen_expenses_from_pr 的 '
  'on conflict (source_item_id) do nothing 需要這個索引才成立 —— '
  '沒有它整個「確認付款日」會直接失敗（migration_150）。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('150_expenses_source_item_unique');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk150;
  create temp table _chk150 (ord int, item text, result text, detail text);

  insert into _chk150 values (1, '★★ 唯一索引',
    case when exists (
      select 1 from pg_indexes
       where schemaname = 'public' and tablename = 'expenses'
         and indexname = 'expenses_source_item_uidx') then '✅' else '❌' end,
    'ON CONFLICT (source_item_id) 需要它才成立');

  /*
   * ★★ 手動建立的支出不能被擋掉。
   *
   * 它們的 source_item_id 是 NULL，而 Postgres 的唯一索引允許多個 NULL。
   * 如果這個數字是 0 而你知道系統裡有手動支出，那就是出事了。
   */
  select count(*) into n from public.expenses where source_item_id is null;
  insert into _chk150 values (2, '★★ 手動支出（source_item_id 為 NULL）', n || ' 筆',
    '唯一索引允許多個 NULL —— 這些不受影響，可以繼續新增');

  select count(*) into n from public.expenses where source_item_id is not null;
  insert into _chk150 values (3, '請款單產生的支出', n || ' 筆', '每筆對一個請款項目');

  select count(*) into n from public.purchase_requests
   where status = 'approved' and purchased_on is null;
  insert into _chk150 values (4, '等著確認付款日的單', n || ' 張',
    case when n = 0 then '' else '★ 現在應該按得下去了 —— 請實際試一張' end);
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk150 order by ord;


-- ============================================================
-- 如果上面 raise exception 了，用這段看是哪幾組重複
-- ============================================================
select
  e.source_item_id                as "來源項目",
  count(*)                        as "重複幾筆",
  string_agg(e.id::text, ' / ')   as "支出 id",
  string_agg(e.spent_on::text, ' / ') as "支出日",
  string_agg(e.amount::text, ' / ')   as "金額"
from public.expenses e
where e.source_item_id is not null
group by e.source_item_id
having count(*) > 1
order by count(*) desc;
