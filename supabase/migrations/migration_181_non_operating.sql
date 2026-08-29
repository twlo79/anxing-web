/*
 * migration_181 —— 支出加上「非營運」標記
 * ============================================================
 * 2026-08-29 使用者：「支出多加一個類似星星的標記 非營運支出，一樣可以篩選出」
 *              「查看非營運資金」「財務儀表板可以排除非營運支出」
 *
 * 【它要回答的問題】
 *
 * 老闆的個人保險、股東往來、跟出租這門生意無關的花費 —— 它們是真的花掉的錢，
 * 帳上必須有，但把它們算進「營運成本」的話，毛利率就不是這門生意的毛利率。
 *
 * 所以需要一個**只做記號、不改任何金額**的欄位：
 *   · 支出頁：標了的項目後面出現「非營運」標籤，可以只看這些
 *   · 財務儀表板：一顆開關把它們從支出與淨額裡扣掉
 *
 * ★★ 支出頁的總額與三張分項卡**照舊全部計入**（使用者指定）。
 *   那一頁是「這段期間花了多少錢」，非營運的錢也是真的花掉了。
 *   要看營運口徑的人去儀表板 —— 一個數字一個地方，不要同一頁兩種口徑。
 *
 * ============================================================
 * 【為什麼是 boolean 而不是 account_code 或 purpose_type】
 *
 * 「非營運」跟會計科目是**兩個獨立的維度**：一筆保險費可能是營運的
 * （物業火險）也可能不是（老闆個人壽險），科目都是「保險費」。
 * 塞進科目就得為每個科目開一個「非營運版」，科目表會膨脹一倍，
 * 而且舊資料無法回溯歸類。
 *
 * ★ `not null default false`：既有的 128 筆全部視為營運支出。
 *   允許 null 的話，「還沒判斷」與「判斷過是營運」會長得一樣，
 *   而畫面上分不出來 —— 也沒有人會回頭補。
 */

alter table public.expenses
  add column if not exists non_operating boolean not null default false;

comment on column public.expenses.non_operating is
  '非營運支出：跟出租本業無關的花費（老闆個人、股東往來…）。'
  '只做記號，不影響支出頁的任何金額；財務儀表板可以用它排除。';

/*
 * ★ 部分索引（只索引 true 的那些）。
 *
 *   非營運支出預期是少數 —— 一般索引會把 128 筆全部收進去，
 *   而其中 120 筆是 false，查詢時根本用不到。
 *   `where non_operating` 只收 true 的那幾筆，索引小得多。
 *
 * ★★ 包在 exception 裡：SQL Editor 把整份腳本當**一個交易**跑，
 *   建索引失敗會讓上面那個 add column 一起回滾。
 */
do $$
begin
  create index if not exists expenses_non_operating_idx
    on public.expenses (spent_on) where non_operating;
exception when others then
  raise warning '索引沒建起來（不影響功能，只是查詢慢一點）：%', sqlerrm;
end $$;

-- ══════════════════════════════════════════════════════════
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回一張表。
-- ══════════════════════════════════════════════════════════
select "檢查項目", "結果", "說明" from (

  /*
   * ★★ `table_schema = 'public'` 一定要帶。
   *   `expenses` 這種名字在其他 schema 也可能有，不帶的話
   *   自檢會抓到別人的表而誤報成功。
   */
  select 1, '★★★ 欄位建好了' as "檢查項目",
         coalesce((select data_type || ' / ' || is_nullable || ' / ' || coalesce(column_default, '(無預設)')
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'expenses'
                      and column_name = 'non_operating'), '⚠ 沒有這個欄位') as "結果",
         '要看到 boolean / NO / false —— 允許 null 的話「還沒判斷」跟「是營運」會長得一樣' as "說明"

  union all
  /*
   * ★ 這支只加欄位，**一列資料都不該動**。
   *   總額變了就是哪裡寫錯了 —— 而那種錯不會報，只會讓報表悄悄對不上。
   */
  select 2, '★★ 既有支出一筆都沒動',
         (select count(*)::text || ' 筆・合計 $'
                 || to_char(coalesce(sum(amount), 0), 'FM999,999,999')
            from public.expenses),
         '這支只加欄位，不改任何金額。數字跟跑之前要一模一樣'

  union all
  select 3, '★ 全部預設為營運支出',
         (select count(*) filter (where non_operating)::text || ' 筆非營運 ／ '
                 || count(*)::text || ' 筆'
            from public.expenses),
         '剛跑完應該是 0 筆非營運 —— 之後由人一筆一筆標'

  union all
  select 4, '部分索引',
         coalesce((select 'OK：' || indexdef from pg_indexes
                    where schemaname = 'public' and indexname = 'expenses_non_operating_idx'),
                  '⚠ 沒建起來（不影響功能）'),
         '只索引 non_operating = true 的那幾筆，索引小得多'

) v order by 1;
