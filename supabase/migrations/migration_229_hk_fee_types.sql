/*
 * migration_229 —— 一次性收入多兩個名目：房務清潔、人事費
 * ============================================================
 * 2026-09-07。承 migration_228:安幸對物業的房務收入要記成一次性收入,
 * 而一次性收入的**會計科目是由這支函式從名目推出來的**。
 *
 * ============================================================
 * 【★★★ 為什麼一定要改這裡，只加前端清單不夠】
 *
 * `lib/fee-types.ts` 自己的註解寫過（migration_148 那次踩到的）:
 *
 *   「兩邊要一起加。只加這裡的話，那筆收入在營收報表上會掉進『其他』,
 *     而金額是對的、名目也是對的，只有分組錯了 —— 沒有人會發現。」
 *
 * 這一次一模一樣:名目選得到、金額也對，但科目會是 `other`,
 * 於是安幸的房務收入在報表上跟一堆雜項混在一起。
 *
 * ============================================================
 * 【★★ 這支函式是整份重寫的，不能只 append】
 *
 * 所以底下那個 CASE 必須跟 migration_204 那一份**一字不差**，只多兩行。
 * 抄漏一行 = 那個名目的收入從此計入「其他」,而且**不會報錯** ——
 * 症狀是幾個月後有人問「運費怎麼不見了」。
 *
 * ★ 自檢第 ② 條把**每一個既有對應**都驗一次,抄漏當場就會亮紅。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

create or replace function public.order_account_code(p_source text, p_fee_type text)
returns text language sql immutable as $fn$
  select case
    -- 一次性收入：名目計入對應科目。名目本身照舊存在 fee_type，不動。
    when p_source in ('oneoff', 'airbnb_cancelled') then
      case coalesce(p_fee_type, '其他')
        when '水費'     then 'utility'
        when '電費'     then 'utility'
        when '瓦斯費'   then 'utility'
        when '水電瓦斯' then 'utility'   -- migration_148
        when '修繕費'   then 'repair'
        when '網路費'   then 'internet'
        when '管理費'   then 'mgmtfee'
        when '清潔費'   then 'cleaning'
        when '停車費'   then 'parking'
        when '設備費'   then 'equipment'
        when '保證金'   then 'guarantee'
        when '運費'     then 'freight'   -- migration_148
        when '稅費'     then 'tax_fee'   -- migration_204
        /*
         * ★★ 房務（migration_229）。
         *   房務清潔 = 安幸對物業收的清潔服務費，跟物業那邊的支出**同一個科目**
         *              （hk_cleaning 於 228 改成 kind=both）。
         *   人事費   = 只有收入端有這個科目;支出端走既有的 salary 薪資勞務。
         *
         * ★ 不可以用 `cleaning 清潔費` —— 那是向**房客**收的,
         *   跟安幸向**物業**收的是兩門生意。混在一起報表就分不出來了
         *   （migration_206 特地分開的理由）。
         */
        when '房務清潔' then 'hk_cleaning'
        when '人事費'   then 'hk_labor'
        -- 認不得的一律計入「其他」
        else 'other'
      end
    -- 其餘全部計入租金收入
    else 'rent_income'
  end
$fn$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('229_hk_fee_types');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 兩個新名目對到正確科目',
         '房務清潔→' || public.order_account_code('oneoff', '房務清潔')
         || '　人事費→' || public.order_account_code('oneoff', '人事費'),
         case when public.order_account_code('oneoff', '房務清潔') = 'hk_cleaning'
               and public.order_account_code('oneoff', '人事費')   = 'hk_labor'
              then '✅ 過' else '❌ 對錯了，收入會掉進「其他」' end

  union all
  /*
   * ★★★ 母體要判定:既有的每一個對應都要還在。
   *   抄漏一行不會報錯,只會讓那個名目的收入從此計入「其他」,
   *   而金額與名目都是對的 —— 幾個月後才有人問「運費怎麼不見了」。
   */
  select 2, '②★★★ 既有 13 個對應一個都沒掉',
         (select string_agg(t.n || '→' || public.order_account_code('oneoff', t.n), '　'
                            order by t.i)
            from (values
              (1,'水費'),(2,'電費'),(3,'瓦斯費'),(4,'水電瓦斯'),(5,'修繕費'),
              (6,'網路費'),(7,'管理費'),(8,'清潔費'),(9,'停車費'),(10,'設備費'),
              (11,'保證金'),(12,'運費'),(13,'稅費')
            ) t(i, n)),
         case when public.order_account_code('oneoff','水費')     = 'utility'
               and public.order_account_code('oneoff','電費')     = 'utility'
               and public.order_account_code('oneoff','瓦斯費')   = 'utility'
               and public.order_account_code('oneoff','水電瓦斯') = 'utility'
               and public.order_account_code('oneoff','修繕費')   = 'repair'
               and public.order_account_code('oneoff','網路費')   = 'internet'
               and public.order_account_code('oneoff','管理費')   = 'mgmtfee'
               and public.order_account_code('oneoff','清潔費')   = 'cleaning'
               and public.order_account_code('oneoff','停車費')   = 'parking'
               and public.order_account_code('oneoff','設備費')   = 'equipment'
               and public.order_account_code('oneoff','保證金')   = 'guarantee'
               and public.order_account_code('oneoff','運費')     = 'freight'
               and public.order_account_code('oneoff','稅費')     = 'tax_fee'
              then '✅ 13 個全對'
              else '❌ 有對應被抄漏了 —— 比對上面那一列找出是哪個' end

  union all
  -- ★ 非一次性收入的那條路不可以被動到
  select 3, '③ 租金那條路沒變',
         'private→' || public.order_account_code('private', null)
         || '　airbnb→' || public.order_account_code('airbnb', '清潔費'),
         case when public.order_account_code('private', null) = 'rent_income'
               and public.order_account_code('airbnb', '清潔費') = 'rent_income'
              then '✅ 過' else '❌ 租金收入的分類被改到了' end

  union all
  select 4, '④ 兩個科目在主檔裡而且方向正確',
         coalesce((select string_agg(code || '(' || name || '/' || kind || ')', '　' order by code)
                     from public.account_codes where code in ('hk_cleaning', 'hk_labor')), '（沒有）'),
         case when (select kind from public.account_codes where code = 'hk_cleaning') = 'both'
               and (select kind from public.account_codes where code = 'hk_labor')   = 'income'
              then '✅ 過' else '❌ 先跑 migration_228' end

  union all
  select 5, '⑤ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '229_hk_fee_types'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '229_hk_fee_types')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
