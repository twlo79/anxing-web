/*
 * 查-那筆 30,000 的刪除紀錄在不在（唯讀）
 * ============================================================
 * 2026-09-05
 *
 * 【上一輪我猜錯了】
 *
 * 我以為 `data_audit_log()` 會在 `auth.uid()` 是 null 時整支跳過。
 * 實際上那個守衛**只在 UPDATE 那一段** —— DELETE 與 INSERT 照記，
 * `user_id` 存成 null。證據：`expenses` 的 delete 有 4 筆。
 *
 * 【更可能的解釋】
 *
 * migration_213 之前就跑過了。這次的 DO 區塊走到
 * 「找不到那筆支出 —— 這一支不做事」直接 return，什麼都沒刪，
 * 所以「最近十分鐘有沒有刪除」當然是 0。
 *
 * 【★★★ 而這是我自己的檢查寫錯】
 *
 * 第 4 列問的是「最近十分鐘有沒有發生刪除」——
 * 那個問題**會隨時間變成 0**，而且它衡量的是「這次跑做了什麼」，
 * 不是「那次刪除有沒有被記到」。
 *
 * 該問的是這一支問的：**那一筆的刪除紀錄在不在**。
 * 它永遠成立，跑一百次答案都一樣
 * （CLAUDE.md：自檢的基準值依賴這支正在改的東西）。
 *
 * 【怎麼跑】整份貼進 SQL Editor。唯讀。
 */

select v.ord, v."項目", v."內容", v."判定" from (

  /*
   * ★★★ 決定性的一列。
   *   那個 id 是 migration_213 寫進暫付 note 裡的原支出 id。
   */
  select 1 as ord, '★★★ 那一筆支出的刪除紀錄' as a,
         coalesce((select label || '｜刪於 ' || at::text
                     || '｜user_id ' || coalesce(user_id::text, 'null（從 SQL Editor 跑的）')
                     from public.data_audit
                    where table_name = 'expenses' and action = 'delete'
                      and record_id = '2fbccb12-b64c-47f8-bd7f-a39d53d771f4'::uuid),
                  '（沒有這筆刪除紀錄）') as b,
         case when exists (select 1 from public.data_audit
                            where table_name = 'expenses' and action = 'delete'
                              and record_id = '2fbccb12-b64c-47f8-bd7f-a39d53d771f4'::uuid)
              then '✅ 記到了 —— 稽核沒壞，是我上一條檢查問錯問題'
              else '❌ 真的沒記到 —— 那 30,000 的刪除沒有軌跡' end as d

  union all
  -- ★ 213 是什麼時候被記錄的。比對上面那個刪除時間就知道是不是同一次
  select 2, '213 是什麼時候記錄的',
         coalesce((select string_agg(name || '｜' ||
                     coalesce(to_jsonb(sm)->>'applied_at',
                              to_jsonb(sm)->>'created_at',
                              to_jsonb(sm)->>'at', '（沒有時間欄位）'), E'\n')
                     from public.schema_migrations sm
                    where name in ('213_move_petty_cash', '212_advance_purpose')),
                  '（沒記到）'),
         'ℹ 跟上面那個刪除時間對一下'

  union all
  -- ★ expenses 那四筆刪除各是什麼，確認我沒認錯
  select 3, 'expenses 的四筆刪除紀錄',
         coalesce((select string_agg(coalesce(label, '（沒有識別）') || '｜' || at::date::text, E'\n'
                     order by at desc)
                     from public.data_audit
                    where table_name = 'expenses' and action = 'delete'), '（一筆都沒有）'),
         'ℹ 那 30,000 應該在裡面'

  union all
  /*
   * ★★ 順帶確認上一輪的另一半：UPDATE 那個守衛是真的洞。
   *   從 SQL Editor 或伺服器端做的 UPDATE **完全沒有紀錄**，
   *   而 INSERT/DELETE 有。這是不對稱的，而畫面上看不出來。
   */
  select 4, '★★ 有幾筆稽核是 user_id 空的',
         (select count(*)::text from public.data_audit where user_id is null)
           || ' 筆（總共 ' || (select count(*)::text from public.data_audit) || ' 筆）',
         case when (select count(*) from public.data_audit where user_id is null) = 0
              then 'ℹ 都是人操作的'
              else '⚠ 這些是系統或 SQL Editor 做的。'
                   || 'UPDATE 那一段有 `uid is null then return` —— 那類的改動一筆都沒記' end

) v(ord, "項目", "內容", "判定")
order by v.ord;
