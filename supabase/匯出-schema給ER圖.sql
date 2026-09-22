/*
 * 匯出線上 schema，給 README 的 ER 圖與欄位清單用。
 *
 * **只讀。** 2026-09-22。
 *
 * ★★★ 為什麼不用 `schema-baseline.sql`:那份是 2026-08-04 的 dump，
 *   README 自己把它列為坑 ——「實際的 policy 比它多」「它根本不含前端那一半」。
 *   照它畫 ER 圖 = 畫一張看起來很完整而且說謊的圖。
 *
 * ══════════════════════════════════════════
 * 【怎麼用】
 *   1. 整段貼進 Supabase SQL Editor 執行
 *   2. 先看**第一張表**（摘要）—— 幾張表、幾個欄位、幾條外鍵
 *   3. 第二張表只有一欄 `line`：右上角 **Download CSV**
 *   4. 把下載到的檔案存成
 *      C:\Users\ASUS\Desktop\anxing-web\supabase\schema-live.csv
 * ══════════════════════════════════════════
 *
 * ★ 每一行是一筆記錄，用 `|` 分隔:
 *     T|表名|大約幾列
 *     C|表名|欄位|型別|可不可以空|預設值
 *     K|表名|主鍵欄位
 *     F|表名|欄位|指到哪張表|指到哪一欄|刪父列時怎麼辦
 *     I|表名|索引名|唯一嗎|定義
 * ★★ `confdeltype` 是 `"char"` 不是 text —— 拼字串一律明寫 `::text`
 *   （2026-09-01 踩過 `operator is not unique`）。
 * ★★★ 掃 `pg_class` 一定要濾 `relkind = 'r'`:不濾的話索引、主鍵、
 *   序列都會被當成「表」（2026-09-17 踩過）。
 */

-- ① 摘要（母體。是 0 的話下面全部不算數）
select
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r')                              as 資料表數,
  (select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid
     join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped) as 欄位數,
  (select count(*) from pg_constraint con join pg_class c on c.oid=con.conrelid
     join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and con.contype='f')                            as 外鍵數,
  case when (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where n.nspname='public' and c.relkind='r') = 0
       then '❌ 一張表都沒有 —— 下面不算數' else '✅ 有東西可以匯出' end      as 判定;

-- ② 匯出（只有一欄 line，右上角 Download CSV）
with t as (
  select c.oid, c.relname::text as tbl,
         coalesce(nullif(c.reltuples, -1), 0)::bigint as approx
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
)
select line from (
  select t.tbl as k1, 0 as k2, 0 as k3,
         'T|' || t.tbl || '|' || t.approx as line
    from t

  union all
  select t.tbl, 1, a.attnum,
         'C|' || t.tbl || '|' || a.attname
           || '|' || format_type(a.atttypid, a.atttypmod)
           || '|' || case when a.attnotnull then 'NOT NULL' else 'null' end
           || '|' || coalesce(replace(pg_get_expr(d.adbin, d.adrelid), '|', '/'), '')
    from t
    join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = t.oid and d.adnum = a.attnum

  union all
  select t.tbl, 2, a.attnum,
         'K|' || t.tbl || '|' || a.attname
    from t
    join pg_constraint con on con.conrelid = t.oid and con.contype = 'p'
    join pg_attribute a on a.attrelid = t.oid and a.attnum = any (con.conkey)

  union all
  select t.tbl, 3, 0,
         'F|' || t.tbl
           || '|' || (select string_agg(a.attname::text, '+' order by a.attnum)
                        from unnest(con.conkey) k
                        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k)
           || '|' || pc.relname
           || '|' || (select string_agg(a.attname::text, '+' order by a.attnum)
                        from unnest(con.confkey) k
                        join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k)
           || '|' || case con.confdeltype::text
                       when 'a' then 'NO ACTION' when 'r' then 'RESTRICT'
                       when 'c' then 'CASCADE'   when 'n' then 'SET NULL'
                       when 'd' then 'SET DEFAULT' else con.confdeltype::text end
    from t
    join pg_constraint con on con.conrelid = t.oid and con.contype = 'f'
    join pg_class pc on pc.oid = con.confrelid

  union all
  select t.tbl, 4, 0,
         'I|' || t.tbl || '|' || i.relname
           || '|' || case when x.indisunique then 'UNIQUE' else '—' end
           || '|' || replace(pg_get_indexdef(i.oid), '|', '/')
    from t
    join pg_index x on x.indrelid = t.oid
    join pg_class i on i.oid = x.indexrelid
   where not x.indisprimary
) z
order by k1, k2, k3, line;
