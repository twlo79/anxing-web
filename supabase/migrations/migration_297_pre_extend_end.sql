/* ══════════════════════════════════════════════════════════════════════
 * migration_297  展延前的租期迄留底                                  2026-09-23
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】展延與刪除延展不是一對逆運算
 *
 *   `doExtend()`   迄日 → 那個月往後推 N 個月的**月底**（永遠是月底）
 *   `delExtBatch()` 迄日 → 「延展起始月的前一個月底」
 *
 *   後者不是「還原」，是**用月底回推**。原本的迄日剛好是月底時才猜得對：
 *
 *     原本 2028-10-31 → 展延 → 2028-11-30 → 刪除 → 2028-10-31   ✅
 *     原本 2028-10-30 → 展延 → 2028-11-30 → 刪除 → 2028-10-31   ❌ 晚 1 天
 *     原本 2026-12-01 → 展延 → 2027-01-31 → 刪除 → 2026-12-31   ❌ 晚 30 天
 *
 *   ★★★ 迄日往後挪 ＝ 那份契約多涵蓋一段時間，而 `gen_contract_orders()`
 *     是照迄日重算月租單的 —— 跨過月底就**多長一張月租單**，未收跟著變多。
 *     而畫面上一個字都不會提：使用者按的是「刪除」，預期回到原狀。
 *     （2026-09-23 在 17B5 上實際發生，差 1 天。）
 *
 * 【這支做什麼】加一欄 `contracts.pre_extend_end_date`
 *   · 第一次展延時把**當下的迄日**寫進去（已經有值就不覆寫 —— 留最早那個才是原始值）
 *   · 刪掉**最早那批**延展時讀回來還原，然後清成 null
 *   · 刪掉後面那幾批不用讀它 —— 每一次展延的結果都是月底，月底回推是對的
 *
 * 【★★ 舊契約沒有留底】這一欄在這支之前不存在，所以 09-23 之前展延過的契約
 *   `pre_extend_end_date` 是 null。前端遇到 null 時維持舊行為（回推月底），
 *   但**會把「原本的迄日沒有留底」講在畫面上**，不安靜猜。
 *
 * 【只加欄位，不動任何一列既有資料】
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

alter table public.contracts
  add column if not exists pre_extend_end_date date;

comment on column public.contracts.pre_extend_end_date is
  '展延之前的租期迄（migration_297）。第一次展延時寫入當下的 end_date，已有值不覆寫；'
  '刪掉最早那批延展時讀回來還原並清成 null。'
  'null ＝ 沒有展延過，或那次展延早於 2026-09-23（前端會退回「回推月底」並在畫面上說）。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('297_pre_extend_end');
  end if;
end $do$;

commit;

-- 自檢（在 commit 後面 —— 看不到就是整支回滾了）
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '297_pre_extend_end') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '297_pre_extend_end')
            then '✅' else '❌' end as 判定
union all select 2, '欄位在不在（要 1）',
       -- ★ 一定要帶 table_schema='public'：其他 schema 也可能有叫 contracts 的表（CLAUDE.md）
       (select count(*)::text from information_schema.columns
         where table_schema = 'public' and table_name = 'contracts'
           and column_name = 'pre_extend_end_date'),
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'contracts'
                            and column_name = 'pre_extend_end_date') then '✅' else '❌' end
union all select 3, '型別是不是 date',
       coalesce((select data_type from information_schema.columns
                  where table_schema = 'public' and table_name = 'contracts'
                    and column_name = 'pre_extend_end_date'), '（沒有這一欄）'),
       case when (select data_type from information_schema.columns
                   where table_schema = 'public' and table_name = 'contracts'
                     and column_name = 'pre_extend_end_date') = 'date' then '✅' else '❌' end
union all select 4, '可以是 null（沒展延過的契約要留空）',
       coalesce((select is_nullable from information_schema.columns
                  where table_schema = 'public' and table_name = 'contracts'
                    and column_name = 'pre_extend_end_date'), '—'),
       case when (select is_nullable from information_schema.columns
                   where table_schema = 'public' and table_name = 'contracts'
                     and column_name = 'pre_extend_end_date') = 'YES' then '✅' else '❌ 不能有 not null' end
union all select 5, '註解有沒有留下（給三個月後的人看）',
       case when coalesce(col_description('public.contracts'::regclass,
              (select ordinal_position from information_schema.columns
                where table_schema = 'public' and table_name = 'contracts'
                  and column_name = 'pre_extend_end_date')::int), '') <> '' then '有' else '沒有' end,
       case when coalesce(col_description('public.contracts'::regclass,
              (select ordinal_position from information_schema.columns
                where table_schema = 'public' and table_name = 'contracts'
                  and column_name = 'pre_extend_end_date')::int), '') <> ''
            then '✅' else '❌' end
union all
-- ★ 母體要判定，不能只當參考：這支不該動到任何一列
select 6, '★ 這支沒有動任何一列資料（有值的 pre_extend_end_date 要是 0）',
       (select count(*)::text from public.contracts where pre_extend_end_date is not null),
       case when (select count(*) from public.contracts where pre_extend_end_date is not null) = 0
            then '✅ 只加欄位；之後展延才會開始有值'
            else '❌ 不該有值 —— 這支只加欄位' end
union all
select 7, '母體：現在有幾張啟用中的契約',
       (select count(*)::text from public.contracts where active),
       case when (select count(*) from public.contracts where active) = 0
            then '⚠ 一張都沒有 —— 上面那幾列等於沒檢查到東西，停下來看'
            else '✅' end
order by 1;
