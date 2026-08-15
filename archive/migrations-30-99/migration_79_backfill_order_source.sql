-- migration_79：回填契約月租單的來源
--
-- 【為什麼 78 沒修完】
-- migration_78 靠 gen_contract_orders 的 upsert 更正 source，但那支函式的迴圈
-- **只走「租期內」的月份**：
--
--     ms := date_trunc('month', ct.start_date);
--     while ms < ct.end_date loop ... on conflict do update set source = ...
--
-- 所以下面這些列碰不到，source 永遠停在錯的值：
--   1. 租期被縮短過 —— 舊月份落在 start_date~end_date 之外
--   2. 契約已停用   —— gen_contract_orders 在 `if not ct.active then return` 就結束了
--   3. 已收款且超出租期 —— delete 只清未收款的，那些列留著但迴圈走不到
--
-- 驗證查詢抓到 21 筆 company 的契約、訂單卻是 longterm，就是這幾種。
--
-- 【修法】
-- 直接一條 update，依 contracts.type 回填。不經過那個迴圈，所以不受租期與
-- 啟用狀態影響。
--
-- source 只是分類，不影響金額 —— 已收款的列也應該歸到正確的類別，
-- 否則營收報表會一直把公司登記的錢算進長租。
--
-- 【護欄】
-- 改 orders 會觸發 trg_orders_recog 重算認列。這支只搬分類，
-- 總營收一分都不該變，所以動前動後比一次，不同就中止。

do $$
declare
  n int; before_total bigint; after_total bigint;
begin
  select coalesce(sum(month_amount), 0)::bigint into before_total from revenue_recognitions;

  update orders o
     set source = case c.type
                    when 'office'  then 'office'
                    when 'company' then 'company'
                    else 'longterm'
                  end
    from contracts c
   where c.id = o.contract_id
     and o.imported_via = 'contract'
     and o.source is distinct from (case c.type
                                      when 'office'  then 'office'
                                      when 'company' then 'company'
                                      else 'longterm'
                                    end);
  get diagnostics n = row_count;
  raise notice '回填 % 列的訂單來源', n;

  select coalesce(sum(month_amount), 0)::bigint into after_total from revenue_recognitions;
  if before_total <> after_total then
    raise exception '總營收被動到了：% → %，差 %。這支只該搬分類。',
      before_total, after_total, after_total - before_total;
  end if;
  raise notice '總營收不變：%', after_total;
end $$;


-- ============================================================
-- 驗證
-- ============================================================

-- 契約類別與訂單來源對不上的列
select c.type as 契約類別, o.source as 訂單來源, count(*) as 筆數,
       bool_or(not c.active) as 含已停用的契約,
       min(o.checkin) as 最早, max(o.checkin) as 最晚
from public.orders o
join public.contracts c on c.id = o.contract_id
where o.imported_via = 'contract' and c.type is distinct from o.source
group by 1, 2;
-- 預期：0 筆

-- 各來源的認列金額。公司登記與辦公室應該回到合理的量級，
-- 長租會少掉原本被誤算進去的那些。
select ym as 月份,
       sum(month_amount) filter (where source = 'longterm')::bigint as 長租,
       sum(month_amount) filter (where source = 'office')::bigint   as 辦公室,
       sum(month_amount) filter (where source = 'company')::bigint  as 公司登記,
       sum(month_amount)::bigint                                    as 總計
from public.revenue_recognitions
where ym >= to_char(current_date - interval '6 months', 'YYYYMM')
group by 1
order by 1 desc;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('79_backfill_order_source'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
