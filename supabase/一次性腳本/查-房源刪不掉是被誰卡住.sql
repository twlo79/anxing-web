/*
 * 查：房源刪不掉
 *   刪除失敗：update or delete on table "properties" violates foreign key
 *   constraint "reviews_property_id_fkey" on table "reviews"
 *
 * 2026-09-22。**只讀，不改任何東西，也不刪任何東西。**
 *
 * 前端按的是 `softDelete('properties', id)`（會移到回收桶），而它最後
 * 還是要把 `properties` 那一列刪掉 —— 只要有任何一張子表的外鍵
 * 指著它而且規則是 NO ACTION／RESTRICT，Postgres 就會擋下來。
 *
 * ★ 那句確認訊息現在寫的是「訂單/評價/清潔的房源文字仍保留」——
 *   那是假設子表只留文字、不留外鍵。這支就是要確認**實際上是不是這樣**。
 *
 * ★★ `confdeltype` 是 `"char"` 不是 text，拼字串一律明寫 `::text`
 *   （2026-09-01 踩過 `operator is not unique`）。
 */

-- ① 有哪些外鍵指到 properties，各自的「刪掉父列時怎麼辦」
--    a=不動(NO ACTION／擋住)　r=RESTRICT(擋住)　c=一起刪　n=設成 null　d=設成預設值
select
  1                                                as 序,
  c.relname::text                                  as 哪張表,
  con.conname::text                                as 外鍵名稱,
  (select string_agg(a.attname::text, '、' order by a.attnum)
     from unnest(con.conkey) k
     join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k) as 欄位,
  case con.confdeltype::text
    when 'a' then '❌ NO ACTION —— 會擋住'
    when 'r' then '❌ RESTRICT —— 會擋住'
    when 'c' then '✅ CASCADE —— 子列一起刪'
    when 'n' then '✅ SET NULL —— 子列的那一欄變 null'
    when 'd' then '✅ SET DEFAULT'
    else '？ ' || con.confdeltype::text
  end                                              as 刪父列時
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_class pc on pc.oid = con.confrelid
join pg_namespace n on n.oid = c.relnamespace
where con.contype = 'f'
  and pc.relname = 'properties'
  and n.nspname = 'public'
order by
  case con.confdeltype::text when 'a' then 0 when 'r' then 0 else 1 end,
  c.relname;

-- ② 擋住的那幾張表，各自掛了幾列
--    ★ 只列 ① 裡面「會擋住」的那幾張。母體是 0 的話 ③ 不算數。
select
  2                                                          as 序,
  '評價 reviews'                                              as 哪張表,
  count(*)                                                   as 總列數,
  count(distinct property_id)                                as 掛到幾間房,
  case when count(*) = 0 then '⚠ 一列都沒有 —— 那就不是它擋的' else '有' end as 判定
from public.reviews where property_id is not null
union all
select 2, '子房源 properties.parent_id（migration_287 加的）',
  count(*), count(distinct parent_id),
  case when count(*) = 0 then '⚠ 沒有子母關係' else '有' end
from public.properties where parent_id is not null;

-- ③ 每一間房分別被哪幾張表卡住、各幾列
--    ★ 只列**真的被卡住**的那幾間，沒被卡的不出現（沒被卡的就是刪得掉的）
with blocked as (
  select p.id, p.name, e.name as estate,
         (select count(*) from public.reviews r where r.property_id = p.id)      as 評價,
         (select count(*) from public.properties c where c.parent_id = p.id)     as 子房源
    from public.properties p
    left join public.estates e on e.id = p.estate_id
)
select
  3                                                          as 序,
  coalesce(estate, '（沒有物業）')                            as 物業,
  name                                                       as 房源,
  評價, 子房源,
  '被 ' || concat_ws('、',
      nullif('評價 ' || 評價, '評價 0'),
      nullif('子房源 ' || 子房源, '子房源 0')) || ' 卡住'     as 判定
from blocked
where 評價 > 0 or 子房源 > 0
order by estate nulls last, name;

-- ④ 母體：一共幾間房、其中幾間刪得掉
select
  4                                                          as 序,
  count(*)                                                   as 房源總數,
  count(*) filter (where
      not exists (select 1 from public.reviews r where r.property_id = p.id)
  and not exists (select 1 from public.properties c where c.parent_id = p.id)
  )                                                          as 現在刪得掉的,
  count(*) filter (where
      exists (select 1 from public.reviews r where r.property_id = p.id)
   or exists (select 1 from public.properties c where c.parent_id = p.id)
  )                                                          as 被卡住的,
  case when count(*) = 0
       then '⚠ 一間房都沒有 —— 上面全部不算數'
       else '✅ 有東西可以檢查' end                            as 判定
from public.properties p;
