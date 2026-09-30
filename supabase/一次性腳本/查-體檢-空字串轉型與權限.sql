/* ══════════════════════════════════════════════════════════════════════
 * 體檢（只讀）：跟「請款單 uuid ''」同一類、還沒爆的地方                    2026-09-30
 *
 * 【只讀】全部是 select，不改任何東西。
 *
 * ① 資料庫函式裡「沒包 nullif 的轉型」—— `(x->>'欄位')::uuid`、`::date`、`::numeric`⋯
 *    前端送空字串 '' 進來就是 `invalid input syntax for type …`，跟這次請款單一模一樣。
 *    （有包 `nullif(x->>'欄位', '')` 的不會列出來）
 * ② 有哪些觸發器掛在請假單、加班單、請款單上 —— 匯入上線前紀錄會不會連帶觸發推播或別的事
 * ③ 開了 RLS 卻一條 policy 都沒有的表 —— 查詢回「成功、0 列」
 * ④ authenticated 讀不到的表（10/30 之後的 grant 規則）
 *
 * ★ 看不到這張表 ＝ 這支本身有錯（不會改到任何東西），把紅字貼給我。
 * ══════════════════════════════════════════════════════════ */

with cast_detail as (
  select p.proname as fn,
         string_agg(distinct m[1], '、') as exprs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
         lateral regexp_matches(p.prosrc,
            '(\(\s*[a-z_0-9]+\s*->>\s*''[a-z_0-9]+''\s*\)\s*::\s*(?:uuid|date|timestamptz|numeric|int|integer|boolean))',
            'gi') as m
   where n.nspname = 'public' and p.prokind in ('f','p')
   group by p.proname
)
select '①' as 區, fn as 名稱, left(exprs, 400) as 內容,
       'ℹ 前端送 '''' 進來會爆的地方 —— 我逐一對前端' as 判定
  from cast_detail
union all
select '②', c.relname || ' ← ' || t.tgname,
       pg_get_triggerdef(t.oid),
       'ℹ 匯入時會一起跑'
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal
   and c.relname in ('leave_requests', 'overtime_requests', 'purchase_requests', 'purchase_request_items')
union all
select '③', c.relname, 'RLS 開著、policy 0 條',
       '❌ 前端查這張表永遠 0 列'
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
   and not exists (select 1 from pg_policy pl where pl.polrelid = c.oid)
union all
select '④', c.relname, 'authenticated 沒有 select 權限',
       case when c.relname in ('app_secrets') then 'ℹ 刻意的' else '⚠ 10/30 之後前端讀不到' end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','v')
   and not has_table_privilege('authenticated', c.oid, 'select')
order by 1, 2;
