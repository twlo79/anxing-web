-- 查詢：listing 39687807 這筆差異，爬蟲到底留下了什麼
--
-- ============================================================
-- 【為什麼查這個】（2026-08-24）
--
-- 同步差異頁上有一列:
--
--     （無房源）listing 39687807 ── 1 筆訂單沒有進來
--     第一次出現 2026-08-19
--
-- 使用者:「爬進來要給更多細節，而非只是一筆訂單」
--         「沒 match 說爬到什麼 —— 名稱、listing id、日期起訖」
--
-- 那筆訂單**根本沒進 orders**（那正是這個差異在講的事），
-- 所以細節只可能在 `sync_issues.extra` 這個 jsonb 裡。
--
-- 前端已經改成「extra 裡有什麼就顯示什麼」（src/lib/sync-extra.ts）——
-- 所以只要爬蟲有塞，畫面立刻就看得到，不用再改前端。
--
-- 這支要回答的是:**爬蟲到底有沒有塞？**
--
--   有  → 部署前端就解決了
--   沒有 → 要改爬蟲（不在這個 repo），下面第三段會列出建議的欄位
--
--
-- ============================================================
-- 【不是 migration，一個字都不改】
-- ============================================================

create temp table _q (ord int, 項目 text, 內容 text) on commit drop;


-- ① 那一筆的完整內容
insert into _q
select 1, '★★ 39687807 這筆的 extra',
       coalesce(i.extra::text, '(null —— 爬蟲什麼都沒留)')
  from public.sync_issues i
 where i.listing_id = '39687807';

insert into _q
select 2, '　同一筆的其他欄位',
       'kind=' || coalesce(i.kind, '—')
       || '　code=' || coalesce(i.code, '—')
       || '　field=' || coalesce(i.field, '—')
       || '　from=' || coalesce(i.from_val, '—')
       || '　to=' || coalesce(i.to_val, '—')
       || '　reason=' || coalesce(i.reason, '—')
  from public.sync_issues i
 where i.listing_id = '39687807';

/*
 * ★ 一筆都沒有的話，那一列可能已經被同步整批換掉了
 *   （migration_113:這張表每次同步整批重建）。
 */
insert into _q
select 3, '　找到幾筆',
       count(*)::text || ' 筆'
       || case when count(*) = 0
               then ' —— 這張表每次同步會整批換掉,可能已經消失了' else '' end
  from public.sync_issues where listing_id = '39687807';


-- ② 別的差異有沒有塞 extra？（判斷爬蟲會不會塞的依據）
insert into _q
select 4, '★ 全部差異裡有 extra 的比例',
       count(*) filter (where extra is not null and extra::text <> '{}')::text
       || ' / ' || count(*)::text || ' 筆有內容';

insert into _q
select 5, '　extra 裡出現過哪些鍵',
       coalesce(string_agg(distinct k, '、' order by k), '(一個都沒有)')
  from public.sync_issues i, lateral jsonb_object_keys(coalesce(i.extra, '{}'::jsonb)) k;


-- ③ 這個 listing 在別的地方留過痕跡嗎
/*
 * 訂單那邊有沒有？（照理說沒有 —— 那正是這筆差異在講的事，
 * 但萬一有，表示問題其實已經解決了、只是差異沒清掉。）
 */
insert into _q
select 6, '　orders 裡有這個 listing 嗎',
       count(*)::text || ' 筆'
       || case when count(*) > 0 then ' ★ 有的話表示問題已解決,差異沒清掉' else '' end
  from public.orders
 where coalesce(airbnb_listing_id::text, '') = '39687807';

/*
 * 房源對照表有沒有？含停用的、含舊編號。
 * 有的話表示對照存在但可能被停用了。
 */
insert into _q
select 7, '　房源對照表裡有嗎',
       coalesce(
         (select string_agg(p.name || case when p.active then '' else '（已停用）' end, '、')
            from public.airbnb_listings l
            join public.properties p on p.id = l.property_id
           where l.listing_id = '39687807'),
         '(對照表裡沒有 —— 要去「房源管理」加上去)');

insert into _q
select 8, '　properties.airbnb_listing_id 有嗎',
       coalesce(
         (select string_agg(name || case when active then '' else '（已停用）' end, '、')
            from public.properties where airbnb_listing_id = '39687807'),
         '(沒有)');


-- ④ 如果 extra 是空的，爬蟲該補什麼
insert into _q values
  (9, '★ 若 extra 是空的 —— 建議爬蟲補這幾個鍵',
      'listing名稱、房客、入住日、退房日、晚數、金額、確認碼'),
  (10, '　為什麼是這幾個',
      '「這是哪一間房」靠 listing名稱；「這筆錢多少」靠金額與日期；'
      || '確認碼是回 Airbnb 後台查的唯一鑰匙'),
  (11, '　前端已經準備好',
      'src/lib/sync-extra.ts 會把 extra 的每一個鍵值對列出來 —— '
      || '爬蟲塞什麼就顯示什麼,不用再改前端');


select "項目", "內容"
  from (select ord, 項目 as "項目", 內容 as "內容" from _q) v
 order by ord;
