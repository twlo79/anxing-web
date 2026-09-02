-- 查詢：39687807 到底是哪一間房（**只有 select，一個字都不改**）
--
-- ============================================================
-- 【為什麼要有這一支】（2026-08-24）
--
-- 上一支查詢問的是「爬蟲有沒有留下細節」。
-- 這一支不等爬蟲 —— **從系統裡已經有的資料反推那是哪一間房**。
--
-- 關鍵發現:`reviews.listing_name_raw` ——
-- 爬蟲抓 Airbnb 評價的時候，把房源名稱的**原始字串**存下來了。
--
-- 所以就算訂單沒進來，只要那間房有過評價，名字就在資料庫裡。
--
--
-- ============================================================
-- 【reviews 沒有 listing_id，所以是用「排除法」】
--
-- reviews 只有 `listing_name_raw` 與 `property_id`，
-- 對不到 39687807 這個編號。
--
-- 但可以反過來問:**哪些房源名稱在系統裡對不到房源？**
-- 那些就是候選 —— 而 39687807 幾乎一定在裡面。
--
-- ★ 這是推論不是證據。所以下面把候選**全部列出來**讓人自己認，
--   不挑一個說「就是這間」。挑錯的話，那個 listing 會被掛到
--   錯的房源上，而之後所有那間房的訂單都會歸錯 ——
--   比現在「一筆沒進來」嚴重得多。
-- ============================================================

create temp table _q (ord int, 項目 text, 內容 text) on commit drop;


-- ① 有評價、但對不到房源的 —— 這些就是候選
insert into _q
select 1, '★★ 對不到房源的評價（候選房源名稱）',
       coalesce(r.listing_name_raw, '(名稱也是空的)')
       || '　評價 ' || count(*)::text || ' 則'
       || '　最近一則 ' || coalesce(max(r.checkin_date)::text, '—')
  from public.reviews r
 where r.property_id is null
 group by r.listing_name_raw
 order by count(*) desc;

insert into _q
select 2, '　小計',
       count(*)::text || ' 種名稱對不到房源'
  from (select distinct listing_name_raw from public.reviews where property_id is null) t;


-- ② 系統裡現有的房源 —— 對照用
/*
 * ★ 把現有房源列出來，是為了讓人**用刪去法**:
 *   候選名稱裡，哪一個不在這份清單上、而且聽起來像真的房子。
 */
insert into _q
select 3, '　現有房源（含停用）',
       string_agg(p.name || case when p.active then '' else '（停用）' end, '、'
                  order by p.name)
  from public.properties p;


-- ③ 這個 listing 有沒有掛在哪裡（含停用、含舊編號）
insert into _q
select 4, '★ properties.airbnb_listing_id',
       coalesce(
         (select string_agg(name || case when active then '' else '（已停用）' end, '、')
            from public.properties where airbnb_listing_id = '39687807'),
         '(沒有任何房源掛這個編號)');

/*
 * ★ 舊編號對照表。一間房可以掛好幾個編號 ——
 *   Airbnb 重新上架會換新編號，舊編號的訂單還是同一間房的。
 */
insert into _q
select 5, '★ 舊編號對照表 property_listings',
       coalesce(
         (select string_agg(p.name
                   || case when l.is_current then '（目前）' else '（舊編號）' end
                   || case when p.active then '' else '・房源已停用' end, '、')
            from public.property_listings l
            join public.properties p on p.id = l.property_id
           where l.listing_id = '39687807'),
         '(對照表裡也沒有)');


-- ④ 差異紀錄本身留了什麼
insert into _q
select 6, '　sync_issues 這筆的 extra',
       coalesce((select extra::text from public.sync_issues
                  where listing_id = '39687807' limit 1),
                '(找不到這筆,或 extra 是 null)');

/*
 * ★ `sync_issue_log`（已處理的差異）**沒有 listing_id 欄位**
 *   （型別是 kind/code/field/from_val/to_val/severity/…），
 *   所以查不了「這個 listing 以前出現過嗎」。
 *   不硬湊一個對不到的 join —— 那只會回一個假的「沒有」。
 */


-- ⑤ 怎麼處理
insert into _q values
  (8, '★ 認出來之後怎麼做',
      '到「房源管理」找到那間房 → listing_id 欄底下按「＋ 加一個舊編號」→ 填 39687807'),
  (9, '　為什麼是加舊編號不是改主編號',
      '一間房可以掛好幾個編號。改主編號的話,原本那個編號的訂單會變成對不到'),
  (10, '★★ 認不出來就不要猜',
      '掛到錯的房源上,之後那間房的所有訂單都會歸錯 —— 比現在「一筆沒進來」嚴重得多');


select "項目", "內容"
  from (select ord, 項目 as "項目", 內容 as "內容" from _q) v
 order by ord;
