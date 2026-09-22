/* 查：是哪一個東西擋住「房源的上層不能是自己」（2026-09-22）。只讀。 */
select 1 as 序, t.tgname::text as 名稱, '觸發器' as 種類,
       pg_get_triggerdef(t.oid) as 定義
  from pg_trigger t
 where t.tgrelid = 'public.properties'::regclass and not t.tgisinternal
union all
select 2, con.conname::text, 'CHECK 約束', pg_get_constraintdef(con.oid)
  from pg_constraint con
 where con.conrelid = 'public.properties'::regclass and con.contype = 'c'
order by 序, 名稱;

/* 那幾支觸發器各自呼叫的函式裡，有沒有這句話 */
select 3 as 序, p.proname::text as 函式,
       case when pg_get_functiondef(p.oid) ~ '上層不能是自己' then '✅ 就是它'
            else '—' end as 是不是它
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind in ('f','p')
   and pg_get_functiondef(p.oid) ~ '\mparent_property_id\M'
 order by p.proname;
