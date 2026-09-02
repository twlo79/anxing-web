-- 查詢：對不到任何訂單或契約的客戶（**只有 select，一個字都不改**）
--
-- ============================================================
-- 【怎麼發現的】（2026-08-24）
--
-- migration_173 統一姓名之後，客戶清單還有 2 筆沒統一:
--
--     MAX        應為「Max」        來源:(對不到任何訂單或契約)
--     jinhee P   應為「Jinhee P」   來源:(對不到任何訂單或契約)
--
-- 而 `contracts.display_name` 需要統一的是 **0 筆** ——
-- 所以不是我原本猜的第二來源問題。
--
-- 這兩筆是**孤兒**:沒有任何訂單或契約支撐它們。
-- `sync_customers()` 只 upsert 不刪除，所以來源被刪掉之後，
-- 客戶那一列會留在原地。這是既有的行為，跟 173 無關。
--
--
-- ============================================================
-- 【為什麼不直接刪】
--
-- 「系統負責看見，人負責決定」（CLAUDE.md）。
--
-- 孤兒客戶可能是:
--   · 訂單被刪掉了（進了回收桶，之後可能會復原）
--   · 曾經有訂單、後來改了名字，舊的那筆留下來
--   · 手動建立的（如果畫面上有那個入口）
--
-- 三種的處理方式不一樣，而**刪掉之後就分不出是哪一種了**。
-- 所以這支只列出來。
-- ============================================================

select
  c.name                                        as "客戶名",
  public.title_case_name(c.name)                as "統一後會是",
  c.property_label                              as "房源",
  c.stay_from                                   as "住宿起",
  c.stay_to                                     as "住宿迄",
  c.stay_count                                  as "住幾次",
  /*
   * ★ 回收桶裡找得到嗎 —— 這是分辨「訂單被刪掉」與「純殘留」的關鍵。
   *   找得到的話不要刪客戶:那筆訂單復原之後，客戶要跟著回來。
   */
  case when exists (
    select 1 from public.trash t
     where t.table_name in ('orders', 'contracts')
       and t.restored_at is null and t.purged_at is null
       and (t.payload->>'guest_name' = c.name
         or t.payload->>'tenant_name' = c.name)
  ) then '★ 在回收桶裡 —— 先不要刪' else '回收桶裡也沒有' end
                                                as "來源在回收桶嗎",
  c.updated_at                                  as "最後更新"
from public.customers c
where c.name is not null
  and not exists (
    select 1 from public.orders o
     where btrim(coalesce(o.guest_name, '')) = c.name)
  and not exists (
    select 1 from public.contracts ct
     where btrim(coalesce(nullif(btrim(ct.tenant_name), ''),
                          nullif(btrim(ct.display_name), ''))) = c.name)
order by c.name;
