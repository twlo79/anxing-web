/*
 * migration_204 —— 契約「價格未稅」＋ 加費新增「稅費」
 * ============================================================
 * 2026-09-02 使用者：
 *   「預設租金含稅價／額外有未稅方塊／若勾選後 下方 開發票會 關起來
 *     若要開發票 要去收租勾加費（也增加）」
 *   「價格未稅／若要開發票，單次每期加稅費，開立發票」
 *
 * ============================================================
 * 【★★ 為什麼是新欄位，不是把 invoice_required 改名】
 *
 *   invoice_required = false   含稅價，只是這個客戶不用開票
 *   tax_free         = true    **這筆租金本來就沒有稅**
 *
 * 現在兩者都設 false 看起來一樣，但意思不同 ——
 * 合成一個欄位的話，之後想查「哪些契約是未稅價」就查不出來了
 * （CLAUDE.md:「一個欄位兼兩個意思」）。
 *
 * ★ 而且方向不同:未稅是**價格的性質**，開不開票是**跟客戶的約定**。
 *
 * ============================================================
 * 【★★★ 約束擋在資料庫，不只擋畫面】
 *
 * 前端會把「需開立發票」整區鎖住，但那只擋得住畫面那一條路。
 * 匯入、SQL 手改、之後新寫的程式都繞得過去 ——
 * 而繞過去之後那張契約會同時是「未稅」又「要開票」，
 * 「待開發票」面板就會叫它去開一張不該開的發票。
 *
 * ★ 所以 check 約束寫在這裡。前端只是讓人不會誤按。
 *
 * ============================================================
 * 【稅費要兩邊一起加】
 *
 * `src/lib/fee-types.ts` 加了 '稅費'，但那只是畫面上的選單。
 * `order_account_code()` 認不得的名目一律計入 'other' ——
 * 於是那筆稅費在營收報表上會掉進「其他」，
 * **金額對、名目對，只有分組錯了，而沒有人會發現**
 * （migration_148 的檔頭就是這樣寫的，這次照抄它的作法）。
 */

-- ══════════════════════════════════════════════════════════
-- ① 契約：價格未稅
-- ══════════════════════════════════════════════════════════
alter table public.contracts
  add column if not exists tax_free boolean not null default false;

comment on column public.contracts.tax_free is
  '價格未稅（migration_204）。false = 租金是含稅價（預設，既有契約全部維持這個）。'
  '★★ true 時**不開發票** —— 要開的話那一期到收租加一筆「稅費」，那一筆才是發票的依據。'
  '★ 跟 invoice_required 是兩件事:未稅是價格的性質，開不開票是跟客戶的約定。';

do $do$ begin
  begin
    /*
     * ★★★ 未稅就不可能要開票。前端會鎖住那一區，但匯入與手改繞得過去 ——
     *   而繞過去之後「待開發票」會叫人去開一張不該開的發票。
     */
    alter table public.contracts
      add constraint contracts_tax_free_chk
      check (not (tax_free and coalesce(invoice_required, false)));
  exception when duplicate_object then null; end;
end $do$;


-- ══════════════════════════════════════════════════════════
-- ② 科目主檔加「稅費」
-- ══════════════════════════════════════════════════════════
/*
 * sort 接在運費（153）後面。
 * ★ kind = 'both' 跟運費一致 —— 收支兩邊都可能用得到，
 *   限成 income 的話支出頁那邊要用就得再改一次。
 */
insert into public.account_codes (code, name, sort, active, kind) values
  ('tax_fee', '稅費', 154, true, 'both')
on conflict (code) do update set
  name = excluded.name, kind = excluded.kind, active = true;


-- ══════════════════════════════════════════════════════════
-- ③ 名目 → 計入科目
-- ══════════════════════════════════════════════════════════
/*
 * ★★★ 只加一行:'稅費' → 'tax_fee'。其餘**一個字都不動** ——
 *   這張對照表是營收報表的分組依據，改動一行就會讓某個科目的
 *   歷史數字整批位移（migration_148 的原話，照抄不是偷懶，
 *   是那句話今天依然成立）。
 */
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
        when '稅費'     then 'tax_fee'   -- ★ 新增（migration_204）
        -- 認不得的一律計入「其他」
        else 'other'
      end
    -- 其餘全部計入租金收入
    else 'rent_income'
  end
$fn$;


-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('204_tax_free');
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★ 基準值不依賴這支改了什麼:第 ② 列問的是「有幾張契約被改成未稅」，
--   而這支一張都不改，正確答案永遠是 0。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '① tax_free 欄位建好了',
         (select case when count(*) = 1
                      then '✅ 預設 ' || max(column_default) else '⚠ 沒有' end
            from information_schema.columns
           where table_schema = 'public' and table_name = 'contracts'
             and column_name = 'tax_free'),
         '★ 預設要是 false —— 既有契約一律維持含稅價，行為不變'

  union all
  select 2, '★★ ② 既有契約一張都沒被改',
         (select count(*) filter (where tax_free)::text || ' 張未稅　／　'
                 || count(*)::text || ' 張總計'
            from public.contracts),
         '★ 這支只加欄位，不改任何一張契約。未稅那個數字現在必須是 0'

  union all
  select 3, '★★★ ③ 約束擋得住「未稅又要開票」',
         (select case when count(*) = 1 then '✅ contracts_tax_free_chk 在'
                      else '⚠⚠⚠ 沒有 —— 匯入或手改可以造出「未稅卻要開票」的契約，'
                           || '而待開發票會叫人去開一張不該開的' end
            from pg_constraint
           where conrelid = 'public.contracts'::regclass
             and conname = 'contracts_tax_free_chk'),
         '★★ 前端只鎖得住畫面那一條路'

  union all
  select 4, '④ 稅費科目',
         (select coalesce(max(code || '　' || name || '　kind=' || kind), '⚠ 沒有')
            from public.account_codes where code = 'tax_fee'),
         '★ 要看到 tax_fee　稅費　kind=both'

  union all
  select 5, '★★ ⑤ 稅費會計入自己的科目',
         (select case when public.order_account_code('oneoff', '稅費') = 'tax_fee'
                      then '✅ 稅費 → tax_fee'
                      else '⚠⚠ 掉進 ' || public.order_account_code('oneoff', '稅費')
                           || ' —— 營收報表會把它歸到那一格' end),
         '★★★ 只加前端選單而漏了這一步的話，**金額對、名目對，只有分組錯**，'
           || '而沒有人會發現（migration_148 的原話）'

  union all
  select 6, '⑥ 其他名目的對照沒被動到',
         (select string_agg(x.k || '→' || public.order_account_code('oneoff', x.k), '　')
            from (values ('運費'),('水電瓦斯'),('清潔費'),('保證金'),('其他')) x(k)),
         '★ 要看到 運費→freight　水電瓦斯→utility　清潔費→cleaning　'
           || '保證金→guarantee　其他→other。任何一個變了就是我改壞了對照表'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
