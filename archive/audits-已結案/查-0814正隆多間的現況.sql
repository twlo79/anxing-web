-- ============================================================
-- 唯讀。08-14 庭玉那份「正隆多間」現在到底長什麼樣子。
--
-- 【為什麼要先查】
-- 我要幫你把它拆成 4B3／13A5／14B1 各 1,500，但我**沒有看過**：
--   1. 那筆工單還在不在、間數是不是還是 0.5
--   2. 4B3／13A5／14B1 這三筆工單存不存在（migration_214 沒跑，應該不在）
--   3. 那三筆 1,530／1,530／1,440 的支出到底是誰產生的、還在不在
--
-- 沒查就寫 migration = 猜。而猜錯的形狀是「多一筆／少一筆」，
-- 總額只是「比較大」或「比較小」，沒有任何地方會叫（CLAUDE.md）。
--
-- 【怎麼跑】整份貼進 SQL Editor，四張表都貼回來給我。
-- ============================================================

-- ── 0. 母體 ──────────────────────────────────────────────────
-- ★ 先確認有東西可查。母體是 0 的話下面全部是空表，
--   而空表看起來跟「全部都正常」一模一樣（2026-09-03 踩過）。
select '202608 的工單總數' as 檢查,
       count(*)::text     as 結果,
       case when count(*) = 0
            then '⚠ 這個月沒有工單 —— 下面全部不算數'
            else '✅ 有母體' end as 判定
  from public.hk_work_item where period = '202608';


-- ── 1. 08-14 那天正隆相關的所有工單 ─────────────────────────
-- ★ 不只查「正隆多間」—— 也要看 4B3／13A5／14B1 在不在，
--   在的話代表有人已經手動補過，那我就不能再建一次。
select w.work_date        as 日期,
       s.name             as 人員,
       w.property_code    as 房務代碼,
       w.work_type        as 工作類型,
       w.units_override   as 間數,
       w.source           as 來源,
       w.note             as 備註,
       coalesce(p.name, '—')            as 對到的ERP房源,
       coalesce(p.clean_price::text, '—') as 清潔費
  from public.hk_work_item w
  left join public.hk_staff    s  on s.id = w.staff_id
  left join public.hk_property hp on hp.code = w.property_code
  left join public.properties  p  on p.id = hp.property_id
 where w.work_date = date '2026-08-14'
   and (w.property_code = '正隆多間'
        or w.property_code in ('4B3', '13A5', '14B1'))
 order by w.property_code, s.name;


-- ── 2. 08-14 已經產生的房務支出 ──────────────────────────────
-- ★★ 這是關鍵的一張。1,530／1,530／1,440 那三筆如果真的存在，
--   改成一筆 4,500 就是「刪兩筆、改一筆」；如果不存在，
--   那我只要建拆帳、按產生就好，什麼都不用刪。
select e.spent_on     as 日期,
       e.item_name    as 項目,
       e.amount       as 金額,
       e.hk_job_key   as 冪等鍵,
       coalesce(p.name, '—')  as 房源,
       coalesce(es.name, '—') as 物業,
       e.tags         as 標籤
  from public.expenses e
  left join public.properties p  on p.id = e.property_id
  left join public.estates    es on es.id = e.estate_id
 where e.spent_on = date '2026-08-14'
   and e.item_name like '房務清潔%'
 order by e.item_name;


-- ── 3. 那三間的房源設定（拆帳要選得到它們） ─────────────────
-- ★ 拆帳的 property_id 是外鍵指到 properties。
--   這三間如果不在，畫面上的下拉根本選不到。
select coalesce(hp.code, '（房務主檔沒有這個代碼）') as 房務代碼,
       p.name         as ERP房源,
       es.name        as 物業,
       p.clean_price  as 清潔費,
       p.clean_points as 打掃點數,
       p.beds         as 床位
  from (values ('4B3'), ('13A5'), ('14B1')) as c(code)
  left join public.hk_property hp on hp.code = c.code
  left join public.properties  p  on p.id = hp.property_id
  left join public.estates     es on es.id = p.estate_id
 order by c.code;


-- ── 4. 這個月還有哪些工單是「一份對多間」的候選 ─────────────
-- ★★ 順便看一次:除了正隆多間，還有沒有別的代碼也該用拆帳處理
--   （時兆公區、開封整棟那幾個）。一次看完比之後再發現一個好。
select w.property_code                  as 房務代碼,
       count(*)                         as 這個月幾份工,
       sum(coalesce(w.units_override, 1)) as 間數合計,
       case when hp.id is null          then '代碼不在房務主檔'
            when hp.property_id is null then '沒對應 ERP 房源'
            when p.clean_price is null  then '沒設清潔費'
       end                              as 為什麼算不出錢
  from public.hk_work_item w
  left join public.hk_property hp on hp.code = w.property_code
  left join public.properties  p  on p.id = hp.property_id
 where w.period = '202608'
   and (hp.id is null or hp.property_id is null or p.clean_price is null)
   and coalesce(btrim(w.property_code), '') <> ''
 group by w.property_code, hp.id, hp.property_id, p.clean_price
 order by count(*) desc;
