/*
 * 查-14B4這個房源能不能刪.sql　2026-09-16
 *
 * 【為什麼查這個】
 * 使用者：「14B4 要刪除，沒這個房源。」
 *
 * ★★★ 我**不直接刪**。`properties` 被十幾張表指著（支出、評價、房務、
 *   採購、清潔紀錄⋯），硬刪要嘛被外鍵擋下來、要嘛把別的東西一起帶走。
 *   而「帶走」那種的症狀是**幾個月後某一份報表少了一塊**，
 *   到時候沒有人記得是這一刀砍的。
 *
 * ★★ 這支**只讀不寫**，跑幾次都一樣，也不會被關帳擋。
 *   先看它身上掛了什麼，再決定是「真的刪」還是「停用」。
 *
 * 【怎麼看】
 *   最後一列的「判定」就是答案：
 *     ✅ 乾淨　→ 可以真的刪掉，我再給你 DELETE 的腳本
 *     ⚠ 有東西 → 不要刪，改成停用（`active = false`
 *                ＋ `show_in_room_calendar = false`）。
 *                舊的支出／評價還連得回去，排房表與入住率不再算它。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，把表格貼回來。
 */

with p as (
  select id, name, estate_id, active, show_in_room_calendar
  from public.properties
  where name = '14B4'
),
/*
 * ★ 一張一張數。用 `exists` 不用 `count(*)`：只要知道「有沒有」，
 *   而幾張大表全掃一次在正式環境上會卡住整個 SQL Editor。
 *   但筆數對決策有用（1 筆跟 800 筆的處理方式不一樣），所以還是數，
 *   只是每一支都用 `where property_id = ...` 走索引。
 */
n as (
  select
    (select count(*) from public.expenses     e where e.property_id = (select id from p)) as expenses,
    (select count(*) from public.orders       o where o.property_id = (select id from p)) as orders_by_id,
    (select count(*) from public.orders       o where o.property_raw = '14B4')            as orders_by_name,
    (select count(*) from public.contracts    c where c.room = '14B4')                    as contracts,
    (select count(*) from public.reviews      r where r.property_id = (select id from p)) as reviews
)

select * from (

  select 1 as "#", '① 這個房源存在嗎' as "區塊",
         coalesce((select name || '（' || case when active then '啟用' else '已停用' end
                   || '・排房表 ' || case when show_in_room_calendar then '顯示' else '不顯示' end || '）'
                   from p), '（找不到叫 14B4 的房源）') as "內容",
         case when not exists (select 1 from p)
              then '✅ 本來就沒有 —— 你看到的那一列來自別的地方（見 ③④）'
              else '存在,往下看它身上掛了什麼' end as "判定"

  union all
  select 2, '② 掛在它 id 上的資料',
         '支出 ' || (select expenses from n) || ' 筆'
         || '・訂單 ' || (select orders_by_id from n) || ' 筆'
         || '・評價 ' || (select reviews from n) || ' 筆',
         case when (select expenses + orders_by_id + reviews from n) = 0
              then '✅ 沒有東西掛著'
              else '⚠ 有東西掛著 —— 刪掉會連帶影響,建議改成停用' end

  union all
  /*
   * ★★ 訂單是用**房號字串**（`property_raw`）對的，不是 id ——
   *   所以就算 `properties` 裡沒有 14B4，訂單那邊還是可能有這個名字。
   *   這兩欄要分開問，不然會漏掉一整條路徑。
   */
  select 3, '③ 訂單裡叫 14B4 的（用房號字串對）',
         (select orders_by_name from n) || ' 筆',
         case when (select orders_by_name from n) = 0 then '✅ 沒有'
              else '⚠ 有 —— 這些訂單的房號要先改掉,不然排房表還是會冒出 14B4' end

  union all
  select 4, '④ 契約裡 room = 14B4 的',
         (select contracts from n) || ' 張',
         case when (select contracts from n) = 0 then '✅ 沒有'
              else '⚠ 有 —— 契約的房號要先改掉' end

  union all
  select 5, '⑤ 這一棟還有哪些像 14B 開頭的房源（確認不是打錯字）',
         coalesce((select string_agg(name, '、' order by name)
                     from public.properties
                    where name like '14B%'), '（一間都沒有）'),
         '參考用 —— 如果 14B1／14B2 都在而只有 14B4 是多的,那就是當初建錯'

  union all
  select 6, '⑥ 結論',
         '',
         case
           when not exists (select 1 from p)
             then '✅ properties 裡根本沒有 14B4 —— 不用刪。畫面上那一列來自訂單或契約的房號（見 ③④）'
           when (select expenses + orders_by_id + reviews + orders_by_name + contracts from n) = 0
             then '✅ 完全沒有東西掛著 —— 可以真的刪掉。把這張表貼回來,我給你 DELETE 的腳本'
           else '⚠ 有東西掛著 —— 不要刪。改成停用:active = false ＋ show_in_room_calendar = false。'
                || '舊資料還連得回去,而排房表、入住率、房務都不再算它'
         end

) t order by t."#";
