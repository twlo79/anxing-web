/*
 * migration_230 —— 認列表帶上「項目」（item_name）
 * ============================================================
 * 2026-09-08。
 *
 * ============================================================
 * 【★★★ 這是一個一直都在的錯，只是沒有人看得出來】
 *
 * `revenue_recognitions.item_name` 這一欄**存在**，
 * `orders.item_name` 也存在，畫面與匯出都在讀它 ——
 * 但 `gen_recognitions()` 從來沒有把它從訂單帶過去。
 * 所以那一欄從第一天起就全部是 null。
 *
 * ★ 症狀有兩個，兩個都不會報錯：
 *
 *   ① 營收清單的來源標籤:`oneoffLabel()` 是「科目・項目」，
 *      項目永遠是 null → 每一筆一次性收入都只剩科目，
 *      十幾筆「其他收入」長得一模一樣。
 *
 *   ② 匯出報表的「一次性底下再依項目拆」（revenue-report.oneoffItems）——
 *      拆出來永遠只有一列。那段程式碼寫了，但從來沒有作用過。
 *
 * ★★ 2026-09-02 使用者問過「為何後面有空」，當時的處理是
 *   **把那個破折號藏起來**（見 lib/revenue-report.ts 的註解:
 *   「項目沒填是常態」）。那個判斷是對的 —— 在資料是 null 的前提下。
 *   真正的原因在這裡。
 *
 * ============================================================
 * 【為什麼現在非修不可】
 *
 * migration_228 之後，房務清潔的收入記在**安幸辦公室**這個物業上，
 * 而使用者指定「房源留空、備註放房號」（2026-09-08）。
 * 營收清單上沒有備註欄（`revenue_recognitions` 沒有 `note`），
 * 所以房號在清單上唯一的出口就是 `item_name`。
 *
 * ★ 不修的話，那一整批收入在營收頁上只剩「客戶」和「金額」分得出來。
 *
 * ============================================================
 * 【★★ 這支函式是整份重寫的】
 *
 * 底下這一份是**線上現行版本一字不差**再加 item_name，
 * 包含第 10~11 行那條「長租且掛在契約上的直接 return」——
 * 那條不在 schema-baseline.sql 裡（快照比線上舊）。
 *
 * ★ 抄漏那一條的話，長租契約的認列會被產生兩次:
 *   一次由這支、一次由 gen_contract_recognitions —— 營收直接翻倍。
 *   自檢第 ② 條專門釘它。
 *
 * ============================================================
 * 【為什麼長租那一段的 item_name 是 null】
 *
 * 跟 `fee_type` 同一個理由:項目是「一次性收入的細目」（洗衣機／
 * 垃圾代收費／房號…），長租沒有這個概念，`orders.item_name` 本來就是 null
 * （shortterm/page.tsx 只在 source==='oneoff' 時才寫）。
 * 寫 `o.item_name` 也一樣是 null，但寫 null 才說得出「這裡刻意不帶」。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

create or replace function public.gen_recognitions(o orders)
 returns void
 language plpgsql
 security definer
as $function$
declare
  ms date; me date; n int; ename text; pname text;
  last_ms date; acc numeric := 0; amt numeric;
begin
  -- 長租且掛在契約上的:認列由 gen_contract_recognitions 依契約產生
  -- ★★★ 這一條不能刪 —— 刪掉的話長租的認列會被產生兩次，營收翻倍
  if o.source = 'longterm' and o.contract_id is not null then return; end if;

  select e.name into ename from estates e where e.id = o.estate_id;
  select p.name into pname from properties p where p.id = o.property_id;
  pname := coalesce(pname, o.property_raw);

  if o.source in ('oneoff', 'airbnb_cancelled') then
    if o.checkin is null or o.amount is null then return; end if;
    ms := date_trunc('month', o.checkin)::date;
    insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
      estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type,
      item_name)   -- ★ migration_230 新增
    values (o.id, to_char(o.checkin,'YYYYMM'), ms, (ms + interval '1 month')::date, 'oneoff', o.estate_id, o.property_id,
      ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, coalesce(o.nights,0), 0, o.amount, coalesce(o.fee_type,'取消費'),
      o.item_name);
    return;
  end if;

  if o.checkin is null or o.checkout is null or o.nights is null or o.nights <= 0 then return; end if;
  last_ms := date_trunc('month', o.checkout - 1)::date;
  ms := date_trunc('month', o.checkin)::date;
  while ms < o.checkout loop
    me := (ms + interval '1 month')::date;
    n := greatest(0, least(o.checkout, me) - greatest(o.checkin, ms));
    if n > 0 then
      if ms = last_ms then amt := o.amount - acc;
      else amt := trunc(o.amount * n / o.nights); acc := acc + amt; end if;
      insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
        estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type,
        item_name)
      values (o.id, to_char(ms,'YYYYMM'), greatest(o.checkin, ms), least(o.checkout, me),
        case when o.source = 'partner' then 'airbnb' else o.source end,
        o.estate_id, o.property_id,
        ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, o.nights, n, amt, null,
        null);   -- ★ 項目是一次性收入的細目，長租沒有 —— 刻意留 null
    end if;
    ms := me;
  end loop;
end $function$;

/*
 * ── 回填 ──────────────────────────────────────────────
 *
 * ★★ 不重跑 rebuild_recognitions()。那支會 **delete from
 *   revenue_recognitions** 再整張重建 —— 契約認列那一批是
 *   gen_contract_recognitions 寫的，重建之後不會回來。
 *
 * ★ 直接補欄位就好:這一欄現在全部是 null，補上去不會蓋掉任何東西。
 */
update public.revenue_recognitions r
   set item_name = o.item_name
  from public.orders o
 where o.id = r.order_id
   and o.item_name is not null
   and r.item_name is distinct from o.item_name;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('230_recog_item_name');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 函式現在帶得到 item_name',
         case when (select prosrc from pg_proc where proname = 'gen_recognitions')
                   like '%o.item_name%' then '有' else '沒有' end,
         case when (select prosrc from pg_proc where proname = 'gen_recognitions')
                   like '%o.item_name%'
              then '✅ 過' else '❌ 沒改到' end

  union all
  /*
   * ★★★ 母體判定:長租契約那條 early return 還在不在。
   *   抄漏它 = 長租的認列被產生兩次，而金額每一筆都正常,
   *   只有月營收整個翻倍 —— 不會報錯。
   */
  select 2, '②★★★ 長租契約那條 early return 還在',
         case when (select prosrc from pg_proc where proname = 'gen_recognitions')
                   like '%o.contract_id is not null then return%' then '在' else '不見了' end,
         case when (select prosrc from pg_proc where proname = 'gen_recognitions')
                   like '%o.contract_id is not null then return%'
              then '✅ 過' else '❌ 抄漏了 —— 長租營收會翻倍，立刻回滾' end

  union all
  select 3, '③ 回填之後還有幾筆訂單有項目、認列表卻是空的',
         (select count(*)::text from public.revenue_recognitions r
            join public.orders o on o.id = r.order_id
           where o.item_name is not null and r.item_name is null),
         case when (select count(*) from public.revenue_recognitions r
                      join public.orders o on o.id = r.order_id
                     where o.item_name is not null and r.item_name is null) = 0
              then '✅ 0 筆' else '❌ 回填沒跑完' end

  union all
  select 4, '④ 現在有項目的認列筆數（回填成果）',
         (select count(*)::text from public.revenue_recognitions where item_name is not null),
         case when (select count(*) from public.revenue_recognitions where item_name is not null) > 0
              then '✅ 有資料了'
              else '⚠ 是 0 —— 代表所有訂單的 item_name 本來就是空的，不一定是錯' end

  union all
  /*
   * ★ 順手驗一次「營收沒有被改動」。
   *   這支只改了一個欄位,總額一毛都不該變 —— 但它是整份重寫的函式,
   *   所以還是要有人看一眼。跟上個月的數字對得起來就對了。
   */
  select 5, '⑤ 本月營收總額（跟改之前對一下）',
         coalesce((select to_char(sum(month_amount), 'FM999,999,999')
                     from public.revenue_recognitions
                    where ym = to_char(now() at time zone 'Asia/Taipei', 'YYYYMM')), '0'),
         '👀 只是給你看，不是判定'

  union all
  select 6, '⑥ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '230_recog_item_name'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '230_recog_item_name')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
