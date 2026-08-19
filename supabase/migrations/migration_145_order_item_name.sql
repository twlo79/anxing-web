-- migration_145：一次性費用也要有「項目」
--
-- ============================================================
-- 【為什麼】（2026-08-19 使用者指定）
--
-- 「固定加費 一次性費用都加入喔」—— 這三個項目兩邊都要有:
--
--     項目：電費   → 會計科目：水電瓦斯
--     項目：飲用水 → 會計科目：管理費
--     項目：其它   → 會計科目：其它
--
-- 固定加費（contract_recurring_charges）本來就有 fee_type ＋ item_name 兩欄,
-- 加預設值就好。
--
-- **但 orders 只有 fee_type,沒有 item_name。**
-- 一次性費用寫進 orders,所以那一層根本沒有地方放。
--
--
-- ============================================================
-- 【為什麼不把「水電瓦斯－電費」塞進 fee_type 就好】
--
-- 那樣營收報表上會出現「水電瓦斯－電費」「水電瓦斯－瓦斯費」
-- 兩個各自獨立的科目 —— **永遠回答不了「水電瓦斯一共收多少」**。
--
-- 這個坑固定加費那邊踩過一次了（見 fee-types.ts 的
-- CONTRACT_FEE_PRESETS 註解:「設備費-冰箱」當初就是差點合成一個字串）。
-- 同一個坑不要在第二張表再踩一次。
--
-- 拆成兩欄之後兩個問題都答得出來:
--   水電瓦斯一共收多少 → 看科目
--   其中電費多少       → 看項目

alter table public.orders
  add column if not exists item_name text;

comment on column public.orders.item_name is
  '一次性費用的**項目**（電費／飲用水／冰箱…）。科目在 fee_type。'
  '兩層分開存,合成一個字串的話營收報表會把「水電瓦斯－電費」'
  '當成一個獨立科目,算不出水電瓦斯的合計（migration_145）。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('145_order_item_name');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk145;
  create temp table _chk145 (ord int, item text, result text, detail text);

  insert into _chk145 values (1, 'orders.item_name',
    case when exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'orders'
                         and column_name = 'item_name') then '✅' else '❌' end,
    '一次性費用的項目。科目仍在 fee_type');

  /*
   * ★ 選填。舊的一次性費用沒有項目,不可以因為這一欄而寫不進去。
   *
   * `information_schema` 一定要帶 table_schema='public' ——
   * orders 這種名字在別的 schema 也可能有,不帶就會誤報。
   */
  insert into _chk145 values (2, '★ 是選填',
    case when (select is_nullable from information_schema.columns
                where table_schema = 'public' and table_name = 'orders'
                  and column_name = 'item_name') = 'YES' then '✅' else '❌ 是必填' end,
    '舊資料沒有項目,設成必填的話那幾筆會改不動');

  select count(*) into n from public.orders where fee_type is not null;
  insert into _chk145 values (3, '現有一次性費用', n || ' 筆',
    '項目都是空的 —— 新的填了才會有,舊的不回頭補（補了是猜的）');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk145 order by ord;
