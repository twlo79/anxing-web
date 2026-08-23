-- migration_141：採購需求加寄送地點，拿掉數量
--
-- ============================================================
-- 【對齊原本的 Google 表單】（2026-08-17 使用者指定）
--
-- 原表單有三個欄位 migration_140 沒帶進來:
--
--     建議採購連結（蝦皮、露天等⋯）
--     寄用地點 *          單選:物業 ＋ 安幸辦公室 ＋ 其他
--     送達樓層也請填寫     例如「2樓儲藏室」
--
-- 而數量欄要拿掉 —— 大概數量寫在「規格說明」裡就好。
--
--
-- ============================================================
-- 【寄送地點放在「單」不放在「項目」】
--
-- 一張需求單是「這次要買的東西」，而這批東西會**一起寄到同一個地方**。
-- 放在項目上的話，填的人要為五樣東西各選一次同樣的地點 ——
-- 而且真的填不一樣的時候，會計要拆成兩張請款單才寄得對。
--
-- 要分開寄就開兩張需求單。那比每一項都問一次誠實。
--
--
-- ============================================================
-- 【為什麼 ship_to 是文字不是 estate_id】
--
-- 選項裡有「安幸辦公室」與「其他」—— 那兩個不是物業。
-- 用 estate_id 的話它們塞不進去，得再加一個「是不是物業」的旗標，
-- 而那個旗標會跟 estate_id 互相矛盾。
--
-- 文字欄位的代價是改物業名稱時舊資料不會跟著改 ——
-- 但寄送地點是「當時寄去哪」的紀錄，本來就不該追著主檔跑。

alter table public.purchase_demands
  add column if not exists ship_to    text,
  add column if not exists ship_floor text;

comment on column public.purchase_demands.ship_to is
  '寄送地點。物業名稱、或「安幸辦公室」、「其他」（migration_141）。'
  '存文字不存 estate_id —— 後兩個不是物業。'
  '這是「當時寄去哪」的紀錄,不追著主檔改名跑。';
comment on column public.purchase_demands.ship_floor is
  '送達樓層／位置。例如「2樓儲藏室」。自由文字 —— 每一棟的說法都不一樣。';


/*
 * 【數量改成選填】
 *
 * 使用者決定不填數量,大概數量寫在規格說明裡。
 *
 * **欄位保留不刪。** 轉請款時請款單的項目仍然有數量,
 * 將來若要從需求單帶過去,這一欄就是那座橋。
 * 刪掉的話那時要再加一次 migration,而中間這段時間的資料就沒有了。
 */
alter table public.purchase_demand_items alter column qty drop not null;
alter table public.purchase_demand_items alter column qty drop default;

comment on column public.purchase_demand_items.qty is
  '數量。**選填**（migration_141）—— 提需求時大概數量寫在 spec 裡。'
  '欄位保留是為了將來轉請款時帶數量,不是現在畫面上要填的東西。';


/*
 * 【建議採購連結】
 *
 * 原本想沿用 `note`，但一個叫 note 的欄位裡放網址，
 * 三個月後看到的人會以為那是備註而在裡面寫別的東西 ——
 * 然後這一欄就同時有兩種內容,而查詢分不出來。
 *
 * 名字誠實一點的成本只有一次 migration。
 */
alter table public.purchase_demand_items
  add column if not exists buy_link text;

comment on column public.purchase_demand_items.buy_link is
  '建議採購連結（蝦皮／露天等）。提需求的人知道去哪買時填,會計省一趟詢價。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('141_demand_shipping');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk141;
  create temp table _chk141 (ord int, item text, result text, detail text);

  insert into _chk141
  select 1, 'purchase_demands.' || c, case when exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'purchase_demands' and column_name = c)
    then '✅' else '❌' end, ''
  from unnest(array['ship_to', 'ship_floor']) c;

  insert into _chk141 values (1, 'purchase_demand_items.buy_link',
    case when exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'purchase_demand_items'
                         and column_name = 'buy_link') then '✅' else '❌' end, '');

  insert into _chk141 values (2, '★ qty 改成選填',
    case when (select is_nullable from information_schema.columns
                where table_schema = 'public' and table_name = 'purchase_demand_items'
                  and column_name = 'qty') = 'YES' then '✅' else '❌' end,
    '欄位保留 —— 將來轉請款要帶數量,那時它就是那座橋');

  /*
   * qty 的 CHECK 還在（qty > 0）。null 不違反 CHECK —— SQL 的
   * `null > 0` 是 unknown 而不是 false，CHECK 只擋明確為 false 的。
   * 這一條實測一次,不然「改成選填但插不進去」會在使用者按送出時才發現。
   */
  begin
    insert into public.purchase_demand_items (demand_id, item_name, estate_id)
    select d.id, '_自檢無數量', e.id
      from public.purchase_demands d, public.estates e limit 1;
    insert into _chk141 values (3, '★★ 不填數量插得進去', '✅', 'CHECK 不擋 null');
    delete from public.purchase_demand_items where item_name = '_自檢無數量';
  exception when others then
    insert into _chk141 values (3, '★★ 不填數量插得進去', '❌ ' || sqlerrm,
      '有東西還在擋 —— 畫面上拿掉欄位會變成按了送出才失敗');
  end;

  select count(*) into n from public.estates where active;
  insert into _chk141 values (5, '★ 寄送地點的選項來源', n || ' 個生效物業',
    '畫面上會再加「安幸辦公室」與「其他」—— 那兩個不是物業,所以 ship_to 存文字');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk141 order by ord, item;
