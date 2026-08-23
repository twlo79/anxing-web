-- migration_127：一間房可以有好幾個 listing_id
--
-- ============================================================
-- 【現在的模型放不下事實】
--
-- migration_126 的自檢列出 47 個卡在停用房源上的 listing_id，裡面有：
--
--     舊-A13（1435252704388238986）  舊-A13（842333091302945663）
--     舊-A18（664230264721654781）   舊-A18（1457776695182019103）
--     舊-A5 （937991450648779450）   舊-A5 （1368655132160485278）
--
-- 同一間房在 Airbnb 上被重建過好幾次，每一次換一個新的 listing_id。
-- 這是事實，不是資料錯誤。
--
-- 而 `properties.airbnb_listing_id` 是**一個欄位加唯一索引** ——
-- 一間房只放得下一個。所以「把 listing_id 搬到現行房源」只是把問題
-- 往前挪一格：A18 拿了 664230…，另一個 1457776… 的訂單照樣對不到，
-- 而那筆訂單**整筆不會進系統**，報表看起來完全正常。
--
--
-- ============================================================
-- 【多對一，不是一對一】
--
--     property_listings
--       listing_id   ← Airbnb 的房源編號（主鍵，一個編號只能指一間房）
--       property_id  ← 指向現行的房源
--
-- 一間房掛幾個歷史編號都行。任何一個編號抓回來的訂單都落到同一間房。
-- 「搬」這個動作消失了 —— 變成「再加一條對照」。
--
--
-- ============================================================
-- 【回填只填「去掉舊字之後完全同名」的】
--
--     舊-A18        → A18          ✓ 去掉「舊-」剛好等於現行房源
--     舊A11(1083)   → A11          ✓ 去掉「舊」與末尾的 (1083)
--     舊-未知(0164) → ？           ✗ 對不到任何現行房源，留著不填
--     整棟(新)      → ？           ✗ 不是「舊」開頭，看不出對應誰
--
-- 對不上的**不猜**。猜錯的後果是那個 listing 的訂單掛到別間房 ——
-- 營收會算到錯的房東頭上，而兩邊的數字看起來都是合理的。
--
-- 剩下的到「權限管理 → 房源管理」用「＋ 加一個舊編號」補，
-- 那裡會給「是不是 A18？」的提示，按下去的還是人。

create table if not exists public.property_listings (
  listing_id  text primary key,
  property_id uuid not null references public.properties(id) on delete cascade,
  /**
   * 現在還在用的那一個。
   *
   * 不是為了對照（對照不管新舊都要生效），是為了**看得懂** ——
   * 一間房掛五個編號時，人要知道哪一個是現在掛在 Airbnb 上的。
   */
  is_current  boolean not null default false,
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists property_listings_prop_idx
  on public.property_listings (property_id);

comment on table public.property_listings is
  'Airbnb listing_id → 房源。一間房可以有多個歷史編號 —— '
  '房源在 Airbnb 上被重建過就會換一個新的，而舊編號的訂單還是要落到同一間房。'
  'properties.airbnb_listing_id 只放得下一個,那是這張表存在的原因。';

alter table public.property_listings enable row level security;

drop policy if exists property_listings_read on public.property_listings;
create policy property_listings_read on public.property_listings
  for select to authenticated using (true);

drop policy if exists property_listings_write on public.property_listings;
create policy property_listings_write on public.property_listings
  for all to authenticated
  using (current_role_of() in ('manager', 'super_admin'))
  with check (current_role_of() in ('manager', 'super_admin'));


-- ── 回填 ───────────────────────────────────────────
do $$
begin
  /*
   * 一、現行（啟用中）房源身上的編號 —— 直接搬進來，標成 current。
   *     這一批沒有任何猜測成分。
   */
  insert into public.property_listings (listing_id, property_id, is_current, note)
  select p.airbnb_listing_id, p.id, true, '從 properties 帶入'
    from public.properties p
   where p.airbnb_listing_id is not null and p.active
  on conflict (listing_id) do nothing;

  /*
   * 二、停用房源身上的編號 → 對到「去掉舊字之後同名」的現行房源。
   *
   * 比對規則寫死在這裡，看得到、改得動：
   *   前綴  舊-  舊   舊舊舊
   *   後綴  (1234) 這種括號編號
   *   最後去空白
   *
   * 唯一一組現行房源對得上才填 —— 對到兩間以上的留空，那正是要人看的。
   */
  with norm as (
    select p.id, p.airbnb_listing_id, p.name,
           trim(regexp_replace(
                  regexp_replace(p.name, '^(舊舊舊|舊-|舊)', ''),
                  '\s*[（(][^）)]*[）)]\s*$', '')) as base
      from public.properties p
     where p.airbnb_listing_id is not null and not p.active
  ),
  hit as (
    select n.airbnb_listing_id, n.name as old_name,
           (select array_agg(c.id) from public.properties c
             where c.active and c.name = n.base) as cands
      from norm n
     where n.base <> n.name          -- 沒有「舊」字的不做,那看不出對應誰
  )
  insert into public.property_listings (listing_id, property_id, is_current, note)
  select h.airbnb_listing_id, h.cands[1], false, '舊編號（原 ' || h.old_name || '）'
    from hit h
   where h.cands is not null and array_length(h.cands, 1) = 1
  on conflict (listing_id) do nothing;
end $$;


-- ── 對照函式 ───────────────────────────────────────
--
-- 對帳與匯入都改讀這裡。
--
-- 【為什麼包成 view 而不是讓程式各自 join】
-- 現在有三個地方在做 listing → 房源（訂單匯入、評價匯入、對帳）。
-- 各寫一次的話，之後多一條規則就要記得改三個地方 ——
-- 而漏掉的那一個不會報錯，只會安靜地少掛一批訂單。
create or replace view public.listing_property_map as
select pl.listing_id,
       pl.property_id,
       p.name       as property_name,
       p.estate_id,
       p.active,
       pl.is_current
  from public.property_listings pl
  join public.properties p on p.id = pl.property_id;

comment on view public.listing_property_map is
  'listing_id → 現行房源。對帳、訂單匯入、評價匯入都讀這個 —— '
  '三個地方各寫一次比對邏輯的話,漏改的那一個會安靜地少掛一批訂單。';

grant select on public.listing_property_map to authenticated;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('127_property_listings');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; m int;
begin
  drop table if exists _chk127;
  create temp table _chk127 (ord int, item text, result text, detail text);

  insert into _chk127 values (1, 'property_listings 表',
    case when to_regclass('public.property_listings') is not null then '✅' else '❌' end, '');

  select count(*) into n from public.property_listings;
  select count(*) into m from public.property_listings where is_current;
  insert into _chk127 values (2, '對照筆數', n || ' 筆', m || ' 個是現行編號');

  -- 一間房掛了幾個編號 —— 這就是舊模型放不下的部分
  insert into _chk127
  select 3, '★ ' || p.name, count(*) || ' 個編號',
         string_agg(pl.listing_id, '、' order by pl.is_current desc, pl.listing_id)
    from public.property_listings pl
    join public.properties p on p.id = pl.property_id
   group by p.name having count(*) > 1;

  /*
   * 還沒對照的舊編號。這才是要行動的清單。
   *
   * 不自動猜 —— 猜錯的後果是那個 listing 的訂單掛到別間房,
   * 營收算到錯的房東頭上,而兩邊的數字看起來都合理。
   */
  select count(*) into n
    from public.properties p
   where p.airbnb_listing_id is not null
     and not exists (select 1 from public.property_listings pl
                      where pl.listing_id = p.airbnb_listing_id);
  insert into _chk127 values (8, '★★ 還沒對照的舊編號',
    case when n = 0 then '✅ 都對好了' else '⚠ ' || n || ' 個' end,
    case when n = 0 then '' else
      (select string_agg(p.name || '（' || p.airbnb_listing_id || '）', '、' order by p.name)
         from public.properties p
        where p.airbnb_listing_id is not null
          and not exists (select 1 from public.property_listings pl
                           where pl.listing_id = p.airbnb_listing_id))
      || ' —— 名稱看不出對應哪一間現行房源。到「權限管理 → 房源管理」'
         '按「＋ 加一個舊編號」補,或確認那間房真的不用了就不用管' end);
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk127 order by ord, item;
