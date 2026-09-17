/*
 * migration_267_lend_usage_items.sql　2026-09-17
 * 代墊暫付的「項目」改成寫項目名稱，不要寫請款單號
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-17：「不要放請款單，放像項目」】
 *
 * 暫付那一頁的「項目」欄現在是：
 *
 *     代墊請款單 PR-202608-075      ← 這個
 *     倉庫-2格                       ← 旁邊的長這樣
 *     零用金撥補                     ← 旁邊的長這樣
 *
 * 單號不是項目 —— 它是一個代號。同一欄裡別的列寫的都是
 * 「這筆錢是在做什麼」，只有代墊那幾列寫的是「這筆錢出自哪張單」。
 *
 * 改成：
 *
 *     115/7月健保費 等 2 筆
 *     旅平險(115/7/1-115/12/23) 等 5 筆
 *     115/7-8月管理服務費            ← 只有一項就不加「等 N 筆」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼不直接改 gen_expenses_from_pr()】
 *
 * 那串字是 `gen_expenses_from_pr()` 裡這一行寫的：
 *
 *     coalesce(nullif(new.advance_usage, ''), '代墊請款單 ' || new.req_no)
 *
 * 但那支函式有 130 行，而我手上只有 migration_237 的版本 ——
 * 238～266 之間有沒有人動過它，我**不知道**。照我這份副本整支
 * `create or replace` 回去，等於拿一份可能過期的東西蓋掉線上的，
 * 而蓋掉的部分**不會叫**。
 *
 * ★ 這就是 2026-09-01 `pg_get_functiondef()` 那次的坑
 *   （沒照抄 dump-schema.sql 就自己寫）的同一種。
 *
 * ★★ 所以改用一支**只碰一個欄位**的 BEFORE INSERT 觸發器。
 *   它看得懂、審得完、而且哪天不要了 drop 掉就回到原狀。
 *
 * ★★★ 代價要講清楚：`usage` 變成有兩個寫的人
 *   （`gen_expenses_from_pr` 先寫、這支改寫）。讀 gen_expenses 的人
 *   會看到它寫「代墊請款單 X」而資料庫裡不是那樣 ——
 *   所以底下有 `comment on column` 指過來。**兩個寫入者一定要有一個地方講**。
 *
 * ══════════════════════════════════════════════════════════
 * 【只改「沒有人手動填過」的那些】
 *
 * 請款單上有一欄「用途」（`advance_usage`）。人填了的話
 * `gen_expenses_from_pr` 會優先用它 —— 那是人寫的字，**不准動**。
 *
 * 所以觸發器與回填都只認 `'代墊請款單 %'` 這個**系統產生的樣子**。
 * 認不出來就原封不動。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】回填帶 `like '代墊請款單 %'` 條件，
 *   第二次跑時已經沒有長那樣的列了，影響 0 列。
 * ══════════════════════════════════════════════════════════
 */

begin;

/*
 * 把一張請款單的項目濃縮成一行字。
 *
 * ★ 排序用 `sort, item_name` —— `sort` 是那張表本來就有的欄位
 *   （schema-baseline:`sort integer not null default 0`）。
 *   不給排序的話，同一張單今天跑跟明天跑可能挑到不同的項目當代表。
 *
 * ★★ 只取第一項 ＋ 「等 N 筆」，不是把全部串起來。
 *   五個項目串起來是 80 個字，那一欄放不下，而放不下就會被截斷 ——
 *   截斷之後看到的是半個項目名稱，比只看到一個完整的還糟。
 *
 * ★ 單一項目名稱也要截（30 字）。有的項目名稱本身就很長，
 *   例如「115/7月電信費-0975792181(115/6/1-115/6/30)」。
 */
create or replace function public.advance_usage_from_items(p_request uuid)
returns text language sql stable
set search_path = public
as $fn$
  with i as (
    select item_name
      from public.purchase_request_items
     where request_id = p_request
       and coalesce(btrim(item_name), '') <> ''
     order by sort, item_name
  ),
  n as (select count(*) as c from i),
  first1 as (select item_name from i limit 1)
  select case
           when (select c from n) = 0 then null
           when (select c from n) = 1
             then left((select item_name from first1), 30)
           else left((select item_name from first1), 30)
                || ' 等 ' || (select c from n)::text || ' 筆'
         end
$fn$;

comment on function public.advance_usage_from_items(uuid) is
  '把一張請款單的項目濃縮成一行「第一項 等 N 筆」,給代墊暫付的「項目」欄用。'
  '★ 只取第一項 —— 全部串起來那一欄放不下,截斷之後會看到半個項目名稱。';

/*
 * ══════════════════════════════════════════════════════════
 * 觸發器：新建的代墊暫付，項目欄直接寫項目名稱
 * ══════════════════════════════════════════════════════════
 *
 * ★ BEFORE INSERT —— 在那一列真的落地之前改掉,
 *   不要 AFTER 再 update 一次（那會多一次寫入,也多一次觸發）。
 *
 * ★★ 三個條件都成立才動:是代墊、有請款單、而且 usage 長得像系統產生的。
 *   人手填的用途**原封不動**。
 */
create or replace function public.ap_usage_from_items()
returns trigger language plpgsql
set search_path = public
as $fn$
declare
  v text;
begin
  if new.category is distinct from '代墊' then return new; end if;
  if new.request_id is null then return new; end if;
  if coalesce(new.usage, '') not like '代墊請款單 %' then return new; end if;

  v := public.advance_usage_from_items(new.request_id);
  /*
   * ★ 撈不出項目就**留著原本那串**。
   *   寫成 null 的話那一欄會變空白 —— 空白比一個看得懂的代號還糟。
   */
  if coalesce(btrim(v), '') <> '' then
    new.usage := v;
  end if;
  return new;
end $fn$;

drop trigger if exists trg_ap_usage_from_items on public.advance_payments;
create trigger trg_ap_usage_from_items
  before insert on public.advance_payments
  for each row execute function public.ap_usage_from_items();

comment on column public.advance_payments.usage is
  '這筆暫付是在做什麼(畫面上「項目」那一欄)。'
  '★★★ 代墊那種有**兩個寫入者**:gen_expenses_from_pr() 先寫成 '
  '「代墊請款單 <單號>」,然後 trg_ap_usage_from_items 把它換成項目名稱 '
  '(migration_267,使用者:「不要放請款單,放像項目」)。'
  '★ 所以讀 gen_expenses_from_pr 會以為這裡是單號 —— 不是。'
  '★★ 人在請款單上手填的「用途」不會被換掉。';

/*
 * ══════════════════════════════════════════════════════════
 * 回填既有的那幾列
 * ══════════════════════════════════════════════════════════
 *
 * ★ 只動長得像系統產生的（`like '代墊請款單 %'`）。
 * ★★ 濃縮不出東西的（沒有項目）就跳過 —— 那一欄不能變空白。
 */
update public.advance_payments a
   set usage = public.advance_usage_from_items(a.request_id)
 where a.category = '代墊'
   and a.request_id is not null
   and coalesce(a.usage, '') like '代墊請款單 %'
   and coalesce(btrim(public.advance_usage_from_items(a.request_id)), '') <> '';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('267_lend_usage_items');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════

with lend as (
  select a.id, a.request_id, a.usage, a.amount::int as amt, a.counterparty,
         r.req_no,
         (select count(*) from public.purchase_request_items i
           where i.request_id = a.request_id) as items
    from public.advance_payments a
    left join public.purchase_requests r on r.id = a.request_id
   where a.category = '代墊'
),
gap as (
  select string_agg(g::text, '　' order by g) as miss
    from generate_series(200, 267) g
   where not exists (select 1 from public.schema_migrations m
                      where split_part(m.name, '_', 1) = g::text)
)

select * from (

  /*
   * ★ 母體要判定（README:母體是空的 → 每一條都回綠）。
   *   一列代墊都沒有的話，下面每一條都自動成立。
   */
  select 1 as ord, '① 母體：代墊暫付' as "檢查",
         (select count(*)::text from lend) || ' 列' as "結果",
         case when (select count(*) from lend) = 0
              then '⚠ **一列都沒有 —— 下面全部不算數**'
              else '參考 —— 第 ②③ 列在判它' end as "判定"

  union all
  /*
   * ★★★ 這一列是這支的目的。跑完之後**一列都不該還寫著單號**。
   */
  select 2, '② 還有沒有寫著單號的',
         coalesce((select string_agg(coalesce(req_no, '?') || '：' || usage, E'\n')
                     from lend where coalesce(usage, '') like '代墊請款單 %'), '（沒有）'),
         case when (select count(*) from lend) = 0 then '⚠ 母體是空的,不算數'
              when exists (select 1 from lend where coalesce(usage, '') like '代墊請款單 %')
              then '⚠ 上面那幾列還寫著單號 —— 它們撈不到項目（項目被刪過？），'
                   || '所以刻意留著原字。**留著代號比留白好**'
              else '✅ 都換成項目名稱了' end

  union all
  /*
   * ★★★ 真正要看的是**換成什麼**。只問「還有沒有舊的」不夠 ——
   *   換成一堆空白也會通過那一條。
   */
  select 3, '③ 現在長什麼樣',
         coalesce((select string_agg(
                     coalesce(counterparty, '?') || ' $' || amt || '　「' || coalesce(usage, '（空白）') || '」',
                     E'\n' order by amt desc) from lend), '（沒有）'),
         case when (select count(*) from lend) = 0 then '⚠ 母體是空的,不算數'
              when exists (select 1 from lend where coalesce(btrim(usage), '') = '')
              then '❌ 有空白的 —— 那一欄空著比寫單號還糟,要查是哪一列'
              else '✅ 每一列都有字' end

  union all
  /*
   * ★★ 濃縮出來的字對不對，要拿**項目筆數**去對。
   *   只有一項的不該有「等 N 筆」，多項的一定要有。
   */
  select 4, '④ 「等 N 筆」跟項目筆數對得起來嗎',
         coalesce((select string_agg(
                     coalesce(req_no, '?') || '：' || items || ' 項　'
                     || case when usage like '%等 % 筆' then '有寫「等 N 筆」' else '沒寫' end,
                     E'\n' order by req_no) from lend), '（沒有）'),
         case when (select count(*) from lend) = 0 then '⚠ 母體是空的,不算數'
              when exists (select 1 from lend
                            where items > 1 and coalesce(usage, '') not like '%等 % 筆'
                              and coalesce(usage, '') not like '代墊請款單 %')
              then '❌ 有多項卻沒寫「等 N 筆」的 —— 看起來只有一項,金額會對不上'
              when exists (select 1 from lend
                            where items = 1 and coalesce(usage, '') like '%等 % 筆')
              then '❌ 只有一項卻寫了「等 N 筆」'
              else '✅ 對得起來' end

  union all
  /*
   * ★★★ 觸發器在不在、而且**條件對不對**。
   *   只問「trigger 在不在」不夠 —— 在但條件寫錯的話,
   *   下一張新的代墊又會寫成單號,而沒有人會發現。
   */
  select 5, '⑤ 下一張新的代墊會自動換嗎',
         coalesce((select t.tgname || '（' ||
                     case t.tgtype::int & 2 when 2 then 'BEFORE' else 'AFTER' end || ' INSERT）'
                     from pg_trigger t
                    where t.tgrelid = 'public.advance_payments'::regclass
                      and t.tgname = 'trg_ap_usage_from_items'
                      and not t.tgisinternal), '★ 沒有這支觸發器'),
         case when not exists (select 1 from pg_trigger t
                                where t.tgrelid = 'public.advance_payments'::regclass
                                  and t.tgname = 'trg_ap_usage_from_items'
                                  and not t.tgisinternal)
              then '❌ 沒有 —— 這次回填完了，但**下一張新的又會寫成單號**'
              when to_regprocedure('public.advance_usage_from_items(uuid)') is null
              then '❌ 觸發器在，但它要呼叫的函式不見了'
              else '✅ 觸發器與函式都在' end

  union all
  select 6, '⑥ 200～267 之間還缺哪幾號',
         coalesce((select miss from gap), '（沒有缺）'),
         case when (select miss from gap) is null then '✅ 一號都沒缺'
              else '⚠ 還缺：' || (select miss from gap) end

  union all
  select 7, '⑦ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '267_lend_usage_items'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '267_lend_usage_items')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
