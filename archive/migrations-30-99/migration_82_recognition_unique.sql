-- migration_82：一筆訂單一個月只能有一列營收認列
--
-- ============================================================
-- 【為什麼】
--
-- migration_81 處理的是「契約 → 訂單」那一段。整條線是：
--
--     契約 ──CASCADE──▶ 訂單 ──CASCADE──▶ 營收認列
--            （81 剛加）        （本來就有）
--
-- 刪除的那一半已經鎖好了。但「重複」的那一半只鎖了一半：
--
--     訂單層  uq_contract_order_month     一契約一月一列   ← 81 建的
--     認列層  （沒有）                                     ← 這一支要補
--
-- 現在 revenue_recognitions 沒有重複，是因為 gen_recognitions 的呼叫端
-- 記得先刪再重產。那是**靠邏輯，不靠約束** —— 跟契約那邊出事之前
-- 一模一樣的狀況。migration_77 就是這樣：邏輯少想了一種情況，
-- 同一張契約同一個月冒出兩列，總營收憑空變高，而且不會報錯。
--
-- 認列這一層更危險，因為它是**報表直接讀的表**。訂單重複至少還看得到
-- 兩列，認列重複只會讓某個月的數字默默變大。
--
--
-- 【建得起來嗎】
-- 執行前的檢查是 0 筆重複，所以可以。這一支不需要清任何資料，
-- 純粹是把現況焊死。
--
--
-- 【會不會擋到正常操作】
-- 不會。正常路徑是「刪掉該訂單的認列 → 重新產生」，一個月一列。
-- 只有在重產前忘了刪的時候才會撞上 —— 那正是我們要它擋下來的情況。
--
-- 撞到的話會是明確的錯誤訊息（唯一鍵衝突），而不是安靜地把營收灌大。
-- **報錯遠比數字錯好。**


-- ── 先確認真的沒有重複 ─────────────────────────────
-- 有的話索引建不起來，這段會把它們列出來讓你先處理。

select order_id, ym, count(*) as 列數, sum(month_amount)::bigint as 金額
from public.revenue_recognitions
where order_id is not null
group by order_id, ym
having count(*) > 1
order by 3 desc;
-- 預期：0 筆


-- ── 建索引 ─────────────────────────────────────────
--
-- 只管 order_id 不是 null 的列。理論上不該有 null（認列一定來自某張訂單），
-- 但 where 條件寫出來比較誠實 —— 部分索引不會因為未來出現 null 就整個失效。

create unique index if not exists uq_recognition_order_month
  on public.revenue_recognitions (order_id, ym)
  where order_id is not null;

comment on index public.uq_recognition_order_month is
  '一筆訂單一個月只能有一列認列。擋的是「重產前忘了刪舊的」造成的營收灌水。'
  '這是硬約束 —— 就算 gen_recognitions 的呼叫端未來寫錯,資料庫也會擋下來。';


-- ============================================================
-- 驗證
--
-- 這裡刻意**不**用「插一列重複的試試看」那種驗法。
-- 唯一索引是宣告式的 —— 只要它 indisunique 且 indisvalid，Postgres 就保證擋得住，
-- 不需要拿真表去撞。而且那種測試要嘛違反 NOT NULL 直接錯在別的地方、
-- 要嘛得偽造一整列，失敗時還會留下髒資料。
--
-- （migration_65 那次「只 select 驗證不到」講的是觸發器 —— 程序碼要跑過才知道。
--   索引不一樣，查系統目錄就是最直接的證明。）
--
-- 整段包在 exception 裡：驗證失敗只發警告，不要把已經建好的索引
-- 連同回滾掉（migration_76 就是那樣一夜白做）。
-- ============================================================

do $$
declare n int;
begin
  -- 1. 索引存在，而且真的是「唯一」且「有效」
  --    indisvalid = false 會發生在 concurrently 建到一半失敗的情況 ——
  --    那種索引看得到卻不生效，是最容易誤判的狀態。
  select count(*) into n
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  where c.relname = 'uq_recognition_order_month'
    and i.indisunique and i.indisvalid and i.indpred is not null;
  if n = 1 then raise notice '✅ 唯一索引已建立且有效（部分索引:order_id is not null）';
  else raise warning '❌ 唯一索引不存在、不是唯一、或尚未生效'; return; end if;

  -- 2. 索引蓋的欄位對不對 —— 建在錯的欄位上一樣是白建
  select count(*) into n
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  where c.relname = 'uq_recognition_order_month'
    and (select array_agg(a.attname::text order by a.attnum)
           from pg_attribute a
          where a.attrelid = i.indrelid and a.attnum = any(i.indkey))
        @> array['order_id', 'ym'];
  if n = 1 then raise notice '✅ 索引蓋的是 (order_id, ym)';
  else raise warning '❌ 索引欄位不是 (order_id, ym)'; end if;

  -- 3. 現有資料沒有重複
  select count(*) into n from (
    select order_id, ym from public.revenue_recognitions
     where order_id is not null group by 1, 2 having count(*) > 1) t;
  if n = 0 then raise notice '✅ 沒有重複認列';
  else raise warning '❌ 還有 % 組重複', n; end if;

  -- 4. 順便把 migration_81 那幾項再確認一次（防護是整條線，缺一段就沒意義）
  select count(*) into n from pg_constraint
   where conname = 'orders_contract_id_fkey' and confdeltype = 'c';
  if n = 1 then raise notice '✅ 契約→訂單 cascade 仍在';
  else raise warning '❌ 契約→訂單外鍵不見了或不是 cascade'; end if;

  select count(*) into n from pg_constraint
   where conrelid = 'public.revenue_recognitions'::regclass
     and confrelid = 'public.orders'::regclass and confdeltype = 'c';
  if n = 1 then raise notice '✅ 訂單→認列 cascade 仍在';
  else raise warning '❌ 訂單→認列外鍵不是 cascade'; end if;

exception when others then
  raise warning '驗證區出錯（索引不受影響）:%', sqlerrm;
end $$;


-- ── 整條線的現況 ───────────────────────────────────

select
  (select count(*) from public.orders o
    where o.contract_id is not null
      and not exists (select 1 from public.contracts c where c.id = o.contract_id))     as 孤兒訂單,
  (select count(*) from public.revenue_recognitions r
    where r.order_id is not null
      and not exists (select 1 from public.orders o where o.id = r.order_id))           as 孤兒認列,
  (select count(*) from (
     select contract_id, checkin from public.orders
      where imported_via = 'contract' and contract_id is not null
      group by 1, 2 having count(*) > 1) t)                                             as 同契約同月重複,
  (select count(*) from (
     select order_id, ym from public.revenue_recognitions
      where order_id is not null group by 1, 2 having count(*) > 1) t)                  as 同訂單同月重複,
  (select coalesce(sum(month_amount), 0)::bigint from public.revenue_recognitions)      as 總營收認列;
-- 預期：0 | 0 | 0 | 0 | 308737465（總額不該因為這一支而改變）


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('82_recognition_unique'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
