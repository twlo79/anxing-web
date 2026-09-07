/*
 * 查-房務支出為何寫不進去（唯讀，第二輪）
 * ============================================================
 * 2026-09-07
 *
 * 上一支確定了:9 月 0 筆、**歷史總共也是 0 筆**，而 `book` 的
 * 預設就是 anxing、兩個冪等鍵的唯一索引也都在。
 *
 * 所以不是被濾掉，是 `upsert` 那一步就沒成功。
 * 而 `generateInner()` 是有接 error 的:
 *
 *     if (error) { flash('產生失敗：' + error.message); return; }
 *
 * → **錯誤訊息有出現過，只是沒被看到**（flash 跳在頁面上方，
 *   而產生面板在下半部。CLAUDE.md:「錯誤訊息跳在頁面最上方」）。
 *
 * ============================================================
 * 【四個嫌疑犯】
 *
 * ① **唯一索引是 partial 的**（`where hk_job_key is not null`）
 *    → `ON CONFLICT (hk_job_key)` **對不到那個索引**，Postgres 直接丟
 *      `there is no unique or exclusion constraint matching the
 *       ON CONFLICT specification`。
 *    ★ PostgREST 的 `onConflict` 只能給欄位名，表達不出 partial 的
 *      WHERE 子句 —— 所以只要索引是 partial 的，這條路就永遠走不通。
 *    這是我目前最懷疑的一個。
 *
 * ② **RLS 沒有 INSERT policy**（或條件不含總經理）
 *    → 那會回 `new row violates row-level security policy`。
 *
 * ③ **`account_code = 'hk_cleaning'` 不是合法的科目**
 *    → 外鍵或 check 擋下來。
 *
 * ④ **有觸發器擋**（像 purchase_request_items 的 `check_account_kind_expense`）
 *
 * 【怎麼跑】整份貼進 SQL Editor，把結果貼回來。唯讀，不寫入。
 */

select v.ord, v."項目", v."內容", v."判定" from (

  -- ══════════ ★★★ ① 索引是不是 partial ══════════
  select 100 + row_number() over (order by indexname) as ord,
         ('★★★ 索引 ' || indexname) as a,
         indexdef as b,
         case when indexdef ilike '%where%'
              then '❌ 是 partial —— `ON CONFLICT (欄位)` 對不到它，upsert 一定失敗'
              else '✅ 不是 partial，ON CONFLICT 對得到' end as d
    from pg_indexes
   where schemaname = 'public' and tablename = 'expenses'
     and (indexdef ilike '%hk_job_key%' or indexdef ilike '%hk_labor_key%')

  -- ══════════ ② RLS ══════════
  union all
  select 200, '② expenses 的 RLS 開了嗎',
         (select case when relrowsecurity then 'RLS 開著' else 'RLS 沒開' end
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'expenses'),
         'ℹ 沒開的話 ② 這條排除'

  union all
  select 210 + row_number() over (order by policyname), '② policy ' || policyname || '（' || cmd || '）',
         'USING: ' || coalesce(qual, '（無）')
           || E'\nWITH CHECK: ' || coalesce(with_check, '（無）'),
         case when cmd in ('INSERT', 'ALL') then '★ 這條管得到 INSERT' else 'ℹ 不管 INSERT' end
    from pg_policies
   where schemaname = 'public' and tablename = 'expenses'

  -- ══════════ ③ 科目 hk_cleaning 合法嗎 ══════════
  union all
  select 300, '★★ ③ account_code = ''hk_cleaning'' 存在嗎',
         coalesce((select 'expenses 裡已經有 ' || count(*)::text || ' 筆用這個科目'
                     from public.expenses where account_code = 'hk_cleaning'), '—')
           || '；科目主檔裡：'
           || coalesce((select string_agg(t.relname::text, '、')
                          from pg_class t join pg_namespace n on n.oid = t.relnamespace
                         where n.nspname = 'public' and t.relkind = 'r'
                           and t.relname ilike '%account%code%'), '（找不到科目表）'),
         'ℹ 已經有別的支出在用的話，這一條排除'

  union all
  select 310, '③ expenses.account_code 有沒有外鍵或 check',
         coalesce((select string_agg(co.conname::text || '：' || pg_get_constraintdef(co.oid), E'\n')
                     from pg_constraint co
                     join pg_class c on c.oid = co.conrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = 'expenses'
                      and co.contype::text in ('f', 'c')
                      and pg_get_constraintdef(co.oid) ilike '%account_code%'),
                  '（沒有 —— 這一條排除）'),
         'ℹ 有外鍵的話,科目要在主檔裡才存得進去'

  -- ══════════ ④ 觸發器 ══════════
  union all
  select 400, '④ expenses 上的觸發器',
         coalesce((select string_agg(t.tgname::text || '（' ||
                     case when (t.tgtype & 2) <> 0 then 'BEFORE' else 'AFTER' end || ' ' ||
                     concat_ws('/',
                       case when (t.tgtype &  4) <> 0 then 'INSERT' end,
                       case when (t.tgtype &  8) <> 0 then 'DELETE' end,
                       case when (t.tgtype & 16) <> 0 then 'UPDATE' end)
                     || ' → ' || p.proname::text || '）', E'\n' order by t.tgname)
                     from pg_trigger t
                     join pg_class c on c.oid = t.tgrelid
                     join pg_namespace n on n.oid = c.relnamespace
                     join pg_proc p on p.oid = t.tgfoid
                    where not t.tgisinternal and n.nspname = 'public'
                      and c.relname = 'expenses'), '（一個都沒有）'),
         '★ BEFORE INSERT 的那幾支才擋得到'

  -- ══════════ ⑤ 必填欄位有沒有沒帶到的 ══════════
  union all
  /*
   * ★★ `mk()` 只寫 12 個欄位。`expenses` 有 30 個，
   *   其中 NOT NULL 又沒有 default 的，少一個就 insert 失敗。
   */
  select 500, '★★ ⑤ NOT NULL 又沒有 default 的欄位',
         coalesce((select string_agg(column_name, '、' order by ordinal_position)
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'expenses'
                      and is_nullable = 'NO' and column_default is null),
                  '（沒有 —— 這一條排除）'),
         '★ 這些 mk() 都要帶。目前它帶的是:spent_on / item_name / amount / '
         || 'account_code / purpose_type / property_id / estate_id / '
         || 'payment_method / tags / no_voucher / hk_job_key / hk_labor_key'

) v(ord, "項目", "內容", "判定")
order by v.ord;
