/*
 * migration_228 —— 房務成對分錄的三個前提
 * ============================================================
 * 2026-09-07 使用者：清潔要產生「安幸辦公室收入 ＋ 物業支出」一對，
 *                    劉姐再多一筆「安幸辦公室 薪資勞務 支出」。
 *
 * 這一支只鋪路，不動任何既有資料的金額。三件事:
 *
 *   ① `hk_cleaning 房務清潔` 從 expense 改成 **both** —— 收入端也要用它
 *   ② 新增 `hk_labor 人事費`（**收入科目**，使用者指定）
 *   ③ 建立「安幸辦公室」物業與房源 —— 收入要掛在訂單上，而訂單一定要有房源
 *
 * ============================================================
 * 【★★★ 為什麼收入沿用同一個 hk_cleaning，而不是新開一個】
 *
 * migration_206 特地把 `hk_cleaning` 跟既有的 `cleaning 清潔費` 分開,
 * 理由寫得很清楚:「cleaning 是向房客收的，這個是我們付出去的房務成本。
 * 混在一起的話報表上『清潔費』會同時包含收進來與付出去的錢」。
 *
 * ★ 但這次不一樣:安幸的收入與物業的支出是**同一件事的兩端**
 *   —— 同一份工、同一個金額、方向相反。用兩個科目的話,
 *   要對「這筆收入對應哪筆支出」得先在腦中換算科目名稱。
 *
 * ★★ 而 `cleaning` 那個混淆的風險在這裡不存在:兩端都是房務清潔,
 *   分得出來的是 **kind（收入／支出）**,不是科目。
 *
 * ============================================================
 * 【★★ 為什麼「安幸辦公室」要建成物業＋房源】
 *
 * 支出那邊有 `purpose_type='office'`（migration_186）——
 * 因為 `expenses.estate_id` 可以是 null。
 *
 * **但訂單不行**:一次性收入是 `orders`,它要掛在物業／房源上。
 * 要嘛改 orders 的結構（連 RLS 與每一支讀訂單的地方一起改）,
 * 要嘛建一個物業。使用者選後者（2026-09-07:「新創一個 房源 安幸辦公室」）。
 *
 * ★ 代價要知道:它會出現在所有選物業的下拉裡,而且營收報表會多一列
 *   「安幸辦公室」。那正是要的 —— 那一列就是房務這門生意的收入。
 *
 * ★★ `clean_price` 留 null —— 它不會被打掃。有價的話哪天有人手滑
 *   在那裡建一份工,就會產生一筆莫名其妙的清潔費。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

-- ══════════════════════════════════════════════════════════
-- ① 房務清潔改成兩邊都能用
-- ══════════════════════════════════════════════════════════
update public.account_codes
   set kind = 'both', active = true
 where code = 'hk_cleaning';

comment on table public.account_codes is
  '收支共用的會計科目。kind: expense／income／both。'
  'hk_cleaning 於 migration_228 改成 both —— 安幸的房務收入與物業的房務支出'
  '是同一件事的兩端，用同一個科目才對得起來。';

-- ══════════════════════════════════════════════════════════
-- ② 人事費（收入科目）
-- ══════════════════════════════════════════════════════════
/*
 * ★ 只有收入。對應的支出端走既有的 `salary 薪資勞務`
 *   —— 正隆付的那 20 萬是薪資，不需要第二個科目。
 */
insert into public.account_codes (code, name, sort, active, kind) values
  ('hk_labor', '人事費', 156, true, 'income')
on conflict (code) do update set
  name = excluded.name, kind = excluded.kind, active = true;

-- ══════════════════════════════════════════════════════════
-- ③ 安幸辦公室：物業 ＋ 房源
-- ══════════════════════════════════════════════════════════
do $do$
declare
  v_estate uuid;
begin
  -- 物業
  select id into v_estate from public.estates where name = '安幸辦公室';
  if v_estate is null then
    /*
     * ★ sort 給 99 —— 排在所有真實物業後面。
     *   它不是一個要去打掃的地方,擺在中間只會擋路。
     */
    insert into public.estates (name, sort, active)
    values ('安幸辦公室', 99, true)
    returning id into v_estate;
  end if;

  -- 房源
  if not exists (select 1 from public.properties where name = '安幸辦公室') then
    insert into public.properties (name, estate_id, active)
    values ('安幸辦公室', v_estate, true);
  else
    -- 已經有了就把它接到正確的物業底下（重跑安全）
    update public.properties set estate_id = v_estate, active = true
     where name = '安幸辦公室' and estate_id is distinct from v_estate;
  end if;
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('228_hk_double_entry');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 房務清潔可以兩邊用',
         coalesce((select code || ' ' || name || ' kind=' || coalesce(kind, 'null')
                     from public.account_codes where code = 'hk_cleaning'), '（沒有這個科目）'),
         case when (select kind from public.account_codes where code = 'hk_cleaning') = 'both'
              then '✅ 過' else '❌ 還不是 both，收入端選不到' end

  union all
  select 2, '② 人事費（收入科目）',
         coalesce((select code || ' ' || name || ' kind=' || coalesce(kind, 'null')
                     from public.account_codes where code = 'hk_labor'), '（沒有）'),
         case when (select kind from public.account_codes where code = 'hk_labor') = 'income'
              then '✅ 過' else '❌ 沒建好' end

  union all
  select 3, '③ 安幸辦公室：物業與房源',
         coalesce((select e.name || '（物業）→ ' || coalesce(p.name, '（沒有房源）')
                     from public.estates e
                     left join public.properties p on p.estate_id = e.id and p.name = '安幸辦公室'
                    where e.name = '安幸辦公室'), '（都沒有）'),
         case when exists (select 1 from public.properties p
                            join public.estates e on e.id = p.estate_id
                           where p.name = '安幸辦公室' and e.name = '安幸辦公室' and p.active)
              then '✅ 過' else '❌ 沒接起來' end

  union all
  /*
   * ★★★ 母體要判定:安幸辦公室**不可以有清潔單價**。
   *   有的話哪天有人在那裡建一份工,就會產生一筆莫名其妙的清潔費,
   *   而金額看起來很正常。
   */
  select 4, '④★★★ 安幸辦公室不該有清潔單價',
         coalesce((select coalesce(clean_price::text, '（null，正確）')
                     from public.properties where name = '安幸辦公室'), '—'),
         case when (select clean_price from public.properties where name = '安幸辦公室') is null
              then '✅ 過' else '⚠ 有單價 —— 會生出不該存在的清潔費' end

  union all
  select 5, '⑤ 既有的薪資勞務科目還在（支出端要用）',
         coalesce((select code || ' ' || name from public.account_codes where code = 'salary'), '（不見了）'),
         case when exists (select 1 from public.account_codes where code = 'salary' and active)
              then '✅ 過' else '❌ 支出端沒有科目可用' end

  union all
  select 6, '⑥ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '228_hk_double_entry'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '228_hk_double_entry')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
