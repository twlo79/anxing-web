-- migration_66：修正「公區清潔」的計布巾設定
--
-- 【問題】
-- migration_59 建 hk_work_type 時把「公區清潔」設成 count_linen = false。
-- 但解析器（hkParse.ts）**從來不會產生這個類型** —— 公區的事件
-- （「時兆公區-34樓洗衣間地板」之類）沒有任何關鍵字命中，一律歸成「清潔」。
--
-- 所以會出現這種情況：
--   匯入進來的公區清掃   → work_type = '清潔'     → 計布巾 ✓
--   手動把格子改成公區清潔 → work_type = '公區清潔' → 計布巾 ✗
--
-- 同一件事，因為來源不同而結果不同。這是那種不會報錯、只會讓數字
-- 悄悄變小的 bug，而且要月底對帳才發現。
--
-- 【為什麼是改設定而不是改解析器】
-- 讓解析器產生「公區清潔」也能一致，但那會讓時兆公區的 8 次
-- 全部退出布巾統計 —— 數字大幅變動，而且沒有必要。
--
-- 公區的 beds = 0，床數 = 次數 × 0 = 0，本來就不會產生任何床單。
-- 這個開關在這裡是多餘的，留著只會製造上面那個不一致。
--
-- 這支不改任何數字，只是把陷阱移掉。

update public.hk_work_type
   set count_linen = true
 where code = '公區清潔' and count_linen = false;

comment on column public.hk_work_type.count_linen is
  '計不計布巾。注意:公區類的房源 beds=0，床數本來就是 0，不需要靠這個開關擋 —— '
  '設成 false 反而會跟解析器產生的「清潔」結果不一致（見 migration_66）。';


-- ============================================================
-- 驗證
-- ============================================================
select code, name, count_workload, count_linen
from public.hk_work_type order by sort;
-- 預期：只有 點交 / 拆備品 / 其他工時 的 count_linen 是 false

-- 這幾個類型在現有資料裡各有幾筆？改設定前先知道會影響多少
select work_type, count(*) as 工作項數,
       count(distinct property_code) as 涉及房源數
from public.hk_work_item
group by work_type order by 2 desc;

-- 拆備品／點交 目前掛在哪些房源上（這些會退出布巾統計）
select w.work_type, w.property_code, p.beds, count(*) as 筆數
from public.hk_work_item w
left join public.hk_property p on p.code = w.property_code
where w.work_type in ('拆備品', '點交', '其他工時')
group by w.work_type, w.property_code, p.beds
order by w.work_type, w.property_code;


-- ── 記錄執行 ───────────────────────────────────────
-- 包在判斷裡，是因為建立 record_migration 的 migration_70 不一定先跑。
-- 順序不對只會少一筆紀錄，不該讓整支 migration 掛掉。
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('66_hk_work_type_consistency'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
