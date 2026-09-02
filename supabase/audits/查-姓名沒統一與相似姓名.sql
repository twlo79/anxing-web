-- 查詢：① 客戶清單還有哪 2 筆沒統一　② 91 個「同名跨房源」的組成
--
-- ============================================================
-- 【這不是 migration】
--
-- 一個字都不改，只有 select。可以重複跑。
--
--
-- ============================================================
-- 【要查什麼】（2026-08-24，migration_173 跑完之後）
--
-- 173 的結果:
--
--     ★★ 這次改了幾筆          165 筆訂單房客 ＋ 2 筆契約承租人
--     ★★ 還有幾筆沒統一         0 訂單 ／ 0 契約      ← 源頭乾淨了
--     客戶清單重算              ✅ 已重算
--     ★ 客戶清單還有幾筆沒統一   2 筆                 ← ❌ 應該是 0
--
-- 源頭是 0、同步跑過了，客戶清單卻還有 2 筆 ——
-- 表示**客戶的名字來源不只那兩欄**。
--
-- 查 migration_105 的 sync_customers()，契約那一段是:
--
--     coalesce(nullif(btrim(c.tenant_name), ''), nullif(btrim(c.display_name), '')) as nm
--                                                              ^^^^^^^^^^^^^^
--
-- `contracts.display_name` 是第二來源，而 173 沒有正規化它。
--
-- ★ 但**先不要直接改 display_name**。
--   migration_105 的註解提醒過:契約有一個 `name` 欄位是「契約的名稱」
--   （可能是「開封 3F 契約」），不是人的名字。
--   `display_name` 到底是人名還是契約名，看過那 2 筆才知道。
--   對不上的不猜 —— 這正是 CLAUDE.md 的第一條判斷原則。
--
--
-- ============================================================
-- 【順便查 91】
--
-- 173 的第 6 項:「同名（統一後）出現在多間房的房客 —— 91 個名字」。
--
-- 防呆新增的「姓名相似」會把這 91 組**逐筆**標出來。
-- 如果大部分是「同一個人真的租了多間」，那會是幾百筆標記，
-- 而標記一多，真正該看的重疊與重複就被淹掉了 ——
-- 那時候這個功能就等於沒有。
--
-- 所以要先看清楚 91 的組成:
--
--     寫法不一致  → 值得標。那是真的資料問題，統一了就少一筆
--     寫法一致    → 可能只是同名，或真的租多間。標了幫助有限
--
-- 看完再決定要不要收窄。
-- ============================================================

create temp table _q (ord int, 區塊 text, 項目 text, 內容 text) on commit drop;


-- ============================================================
-- ① 客戶清單還沒統一的那幾筆 —— 它們從哪來？
-- ============================================================
insert into _q
select 1, '一、沒統一的客戶', c.name,
       '應為「' || public.title_case_name(c.name) || '」'
       || '　來源:'
       || coalesce(
            (select string_agg(
               case when nullif(btrim(ct.tenant_name), '') is not null
                    then '契約.tenant_name'
                    else '契約.display_name' end, '、')
               from public.contracts ct
              where btrim(coalesce(nullif(btrim(ct.tenant_name), ''),
                                   nullif(btrim(ct.display_name), ''))) = c.name),
            '')
       || coalesce(
            (select '　訂單.guest_name × ' || count(*)::text
               from public.orders o where btrim(coalesce(o.guest_name, '')) = c.name
              having count(*) > 0),
            '')
       || coalesce(
            (select '　(對不到任何訂單或契約)'
              where not exists (
                select 1 from public.contracts ct
                 where btrim(coalesce(nullif(btrim(ct.tenant_name), ''),
                                      nullif(btrim(ct.display_name), ''))) = c.name)
                and not exists (
                select 1 from public.orders o
                 where btrim(coalesce(o.guest_name, '')) = c.name)),
            '')
  from public.customers c
 where c.name is not null
   and c.name <> public.title_case_name(c.name);


-- ============================================================
-- ② contracts.display_name 有幾筆需要統一
-- ============================================================
insert into _q
select 2, '二、display_name', '需要統一的筆數',
       count(*)::text || ' 筆'
       || case when count(*) > 0
               then '　例:「' || min(display_name) || '」→「'
                    || public.title_case_name(min(display_name)) || '」'
               else '' end
  from public.contracts
 where display_name is not null
   and display_name <> public.title_case_name(display_name);

/*
 * ★ 這一項是判斷「display_name 是人名還是契約名」的依據。
 *   含「契約」「租約」「合約」這種字的，多半是契約名稱不是人名 ——
 *   那種**不該**套人名正規化。
 */
insert into _q
select 3, '二、display_name', '看起來像契約名稱的',
       count(*)::text || ' 筆'
       || case when count(*) > 0 then '　例:「' || min(display_name) || '」' else '' end
  from public.contracts
 where display_name is not null
   and (display_name like '%契約%' or display_name like '%租約%'
     or display_name like '%合約%' or display_name like '%整棟%');


-- ============================================================
-- ③ 91 個「同名跨房源」的組成
-- ============================================================
/*
 * 用「第一個詞」分組 —— 跟防呆的 firstNameToken 同一套規則
 * （src/lib/audit-orders.ts 的 1.5 段）。
 *
 * ★ split_part(name, ' ', 1) 只切半形空白。173 已經把全形空白
 *   收成半形了，所以這裡對得上。
 */
with g as (
  select lower(split_part(btrim(guest_name), ' ', 1))   as tok,
         count(distinct guest_name)                      as 寫法數,
         count(distinct property_raw)                    as 房源數,
         count(*)                                        as 訂單數,
         string_agg(distinct guest_name, '、')            as 名字們
    from public.orders
   where guest_name is not null and btrim(guest_name) <> ''
     and coalesce(source, '') <> 'airbnb_cancelled'
   group by 1
  having count(distinct property_raw) > 1
)
insert into _q
select 4, '三、91 的組成',
       case when 寫法數 > 1 then '★ 寫法不一致（值得標）' else '寫法一致（可能只是同名）' end,
       count(*)::text || ' 組　共 ' || sum(訂單數)::text || ' 筆訂單會被標'
  from g group by 寫法數 > 1;

/*
 * ★ 寫法不一致的那幾組，直接列出來。
 *   這些是真的可以馬上處理的 —— 統一寫法就少一筆。
 */
insert into _q
select 5, '四、寫法不一致的名單', 名字們,
       房源數::text || ' 間房 ／ ' || 訂單數::text || ' 筆訂單'
  from (
    select lower(split_part(btrim(guest_name), ' ', 1))  as tok,
           count(distinct guest_name)                     as 寫法數,
           count(distinct property_raw)                   as 房源數,
           count(*)                                       as 訂單數,
           string_agg(distinct guest_name, '、')           as 名字們
      from public.orders
     where guest_name is not null and btrim(guest_name) <> ''
       and coalesce(source, '') <> 'airbnb_cancelled'
     group by 1
    having count(distinct property_raw) > 1
       and count(distinct guest_name) > 1
  ) t
 order by 訂單數 desc
 limit 30;


select "區塊", "項目", "內容"
  from (select ord, 區塊 as "區塊", 項目 as "項目", 內容 as "內容" from _q) v
 order by ord;
