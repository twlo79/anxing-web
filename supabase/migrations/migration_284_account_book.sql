/*
 * migration_284_account_book.sql　2026-09-21
 * 收付款帳號分成三本帳：安幸／愛皮／洪鯊，並補上「愛皮現金」「洪鯊現金」
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *            自檢在 commit 後面，成功就一定看得到。把錯誤訊息整段貼回來。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-21】
 *   「我要把帳號切出來，分成 安幸帳號／愛皮帳號／洪鯊帳號。
 *     24195 是愛皮的，1624 是洪鯊的。多創 愛皮現金、洪鯊現金。」
 *   「安幸的支出頁 這些只能用 安幸的支出」
 *   「其他收支帳的 進款 出款 是出在各事業體的帳本」
 *   問答:JIM 那四張 → 安幸　·　正隆現金 → 安幸　·　一張單不可以跨事業體
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 這一支只加資料，不改任何行為】
 *
 *   加一欄 `book`、回填、新增兩筆現金帳號、加一條 check。
 *   **完全沒有動 `gen_expenses_from_pr()`**，也沒有動任何前端讀得到的規則 ——
 *   跑完之後畫面跟現在一模一樣。
 *
 * ★ 為什麼要分兩步:改判定（「用誰的帳戶付」決定是不是代墊）是另一支。
 *   跟加欄位混在一起的話，出事時分不出是欄位的問題還是判定的問題，
 *   而唯一的還原點在兩件事之前。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼 default 是 'anxing'】
 *
 * 現有 11 個帳號裡，**九個是安幸的**（含 JIM 那四張與正隆現金 ——
 * 2026-09-21 使用者指定都歸安幸），只有 4195 與 1624 不是。
 * 所以 `not null default 'anxing'` 一次填完九個，再改那兩個。
 *
 * ★★ 反過來做（default null，之後再一個一個填）**不行**:
 *   null 的帳號在畫面上會「哪一組都不出現」——
 *   而那看起來是一個很正常的空清單，沒有任何地方會叫
 *   （README 坑:新建表沒 policy → 回成功 0 列，同一種形狀）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 帳本的值照程式裡那份清單，不是我造的】
 *
 * `src/lib/book.ts`:`export const BOOKS = ['anxing', 'aipi', 'hongsha']`
 * —— 前端就是拿這三個值在寫資料庫，所以拼法以它為準。
 *
 * ★★★ 第 ① 步問的是「資料裡**有沒有我不認得的**帳本」，
 *   **不是**「這三個是不是都有資料」。
 *
 *   第一版寫成後者，結果在線上被自己擋下來 ——
 *   訊息是「非安幸帳本是『aipi』，找不到 aipi 或 hongsha」:
 *   **洪鯊是籌備處，一筆支出都還沒有**，而那是一個完全合法的形狀。
 *   （README 坑:自檢沒涵蓋既有資料的合法形狀 → 把正常當成錯誤。）
 *
 * ★ 真正要擋的是反過來那一邊:資料裡有第四種帳本而我不知道 ——
 *   那樣 `pa_book_chk` 會把一個合法的值擋在外面，
 *   而症狀是「新增那本帳的帳號時存不了」。
 *
 * ══════════════════════════════════════════════════════════
 * 【★ 代號一個都不改】
 *
 * 畫面上寫著「代號一旦有交易掛上就不要再改」。這一支**多一欄**，
 * 代號、顯示名稱、排序一個字都沒動，舊資料全部安全。
 * 而且查過了:4195 與 1624 **一筆交易都沒用過**
 * （`supabase/一次性腳本/查-帳號4195與1624用在哪裡.sql`）。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ① 閘門：帳本代號要真的存在於現有資料裡 ══════
do $do$
declare
  v_books text;
  r       record;
begin
  if to_regclass('public.payment_accounts') is null then
    raise exception 'payment_accounts 不在 —— 整支停下來沒有改任何東西。';
  end if;

  /*
   * ★★★ 掃**所有**放帳本的欄位，不是只掃 expenses ——
   *   洪鯊還沒有支出，但它可能已經有訂單或暫付。
   * ★ 每一個來源都先確認欄位存在才掃（欄位名不對只會少一個來源，
   *   不會把整支炸掉）。
   */
  create temp table if not exists _bk_seen (v text);
  delete from _bk_seen;

  for r in
    select * from (values
      ('expenses', 'book'), ('orders', 'book'),
      ('purchase_requests', 'book'), ('purchase_requests', 'advance_for_book'),
      ('advance_payments', 'for_book')
    ) t(tbl, col)
  loop
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = r.tbl and column_name = r.col)
    then
      execute format('insert into _bk_seen select distinct %I from public.%I where %I is not null',
                     r.col, r.tbl, r.col);
    end if;
  end loop;

  /*
   * ★★★ 要擋的是「有我不認得的帳本」。
   *   有的話 pa_book_chk 會把一個合法的值擋在外面。
   */
  select coalesce(string_agg(distinct v, '、' order by v), '')
    into v_books
    from _bk_seen
   where v not in ('anxing', 'aipi', 'hongsha');

  if v_books <> '' then
    raise exception
      '資料裡有我不認得的帳本代號「%」—— 整支停下來沒有改任何東西。'
      '把這句話貼回對話裡，我把它加進 pa_book_chk。', v_books;
  end if;

  /*
   * ★★ 愛皮確實有資料（查過:3 張 other_biz 的單、8 筆代墊都是 aipi）。
   *   一個 aipi 都掃不到的話，是我掃錯欄位了 —— 那要停下來。
   * ★ 洪鯊**不強制** —— 它是籌備處，還沒有資料是正常的。
   */
  if not exists (select 1 from _bk_seen where v = 'aipi') then
    raise exception
      '所有帳本欄位裡一個 aipi 都沒有 —— 我可能掃錯欄位了，整支停下來沒有改任何東西。';
  end if;
end $do$;


-- ══════ ② 加欄位 ══════
/*
 * ★ `if not exists`:這一支要能重跑。第二次跑的時候這一句不做事，
 *   底下每一步也都是「看結果決定」而不是「無條件做」。
 */
alter table public.payment_accounts
  add column if not exists book text not null default 'anxing';

comment on column public.payment_accounts.book is
  '這個帳號屬於哪一本帳:anxing／aipi／hongsha（migration_284）。'
  '決定三件事:① 安幸支出頁的下拉只列 anxing ② 其他收支帳各分頁只列自己那本 '
  '③ 請款單拿「項目的事業體」跟這一欄比,不一樣才是代墊。'
  '★ 新增帳本時要同時改 pa_book_chk 這條約束。';


-- ══════ ③ 那兩個不是安幸的 ══════
do $do$
declare v_n int;
begin
  update public.payment_accounts set book = 'aipi'    where code = '4195';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '代號 4195（愛皮元大 24195）改到 % 列，不是剛好 1 列 —— 整支停下來。', v_n;
  end if;

  update public.payment_accounts set book = 'hongsha' where code = '1624';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '代號 1624（洪鯊玉山 31624）改到 % 列，不是剛好 1 列 —— 整支停下來。', v_n;
  end if;
end $do$;


-- ══════ ④ 補兩筆現金帳號 ══════
/*
 * ★★ 照現有兩筆現金（安幸現金／正隆現金）的形狀抄:
 *     for_income  = false   現金不當收款帳戶
 *     for_payment = true
 *   憑印象填的話，那兩筆會出現在不該出現的下拉裡（README 二-6）。
 *
 * ★ 用 `where not exists` 不用 `on conflict` —— code 上有沒有唯一索引
 *   我沒有親眼確認過，而 `on conflict (code)` 對不到索引就是整支炸掉
 *   （跟 PostgREST 對不到 partial 索引同一種病）。
 */
insert into public.payment_accounts (method, code, name, for_income, for_payment, sort, book, active)
select v.method, v.code, v.name, false, true, v.sort, v.book, true
  from (values
    ('cash', '愛皮現金', '(愛皮)現金', 10, 'aipi'),
    ('cash', '洪鯊現金', '(洪鯊)現金', 11, 'hongsha')
  ) v(method, code, name, sort, book)
 where not exists (
   select 1 from public.payment_accounts p where p.code = v.code
 );


-- ══════ ⑤ 約束：帳本只有這三種 ══════
/*
 * ★★ 先 drop 再 add，這一支才重跑得了。
 * ★ 約束的定義同時寫進上面那段 COMMENT —— 哪天要開第四本帳，
 *   看 COMMENT 就知道有一條約束要一起改（README 二-9）。
 */
alter table public.payment_accounts drop constraint if exists pa_book_chk;
alter table public.payment_accounts
  add constraint pa_book_chk check (book in ('anxing', 'aipi', 'hongsha'));


do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('284_account_book');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 = 整支回滾了。
-- ══════════════════════════════════════════════════════════
select * from (

  /*
   * ★★★ 母體要判定（README 二-1）——
   *   一個帳號都沒有的話，下面每一條都會自動成立。
   */
  select 1 as ord, '★★★ ① 一共有幾個帳號' as "檢查",
         (select count(*)::text || ' 個' from public.payment_accounts) as "結果",
         case when (select count(*) from public.payment_accounts) = 0
              then '⚠ 一個都沒有 —— 下面全部不算數'
              else '✅ 有東西可以檢查' end as "判定"

  union all
  /* ② 每一本帳各幾個。★ 這一列**要你自己看一眼**:
       安幸 9（含 JIM 四張 ＋ 正隆現金）、愛皮 2、洪鯊 2 */
  select 2, '★★ ② 每一本帳各幾個（自己看一眼對不對）',
         coalesce((select string_agg(b || ' ' || c::text || ' 個', '、' order by b)
                     from (select book as b, count(*) as c
                             from public.payment_accounts group by 1) g), '（沒有資料）'),
         case when (select count(*) from public.payment_accounts where book = 'anxing') = 9
               and (select count(*) from public.payment_accounts where book = 'aipi') = 2
               and (select count(*) from public.payment_accounts where book = 'hongsha') = 2
              then '✅ 9 / 2 / 2，跟預期一樣'
              else 'ℹ 跟 9/2/2 不同 —— 不一定是錯的（可能你自己加過帳號），看一眼再決定' end

  union all
  /* ★★★ 問「結果對不對」不是「這次改了幾列」——
     後者跑第二次會變 0，看起來像壞掉（README 二-3）。 */
  select 3, '★★★ ③ 4195 是愛皮的嗎',
         coalesce((select book || '　' || name from public.payment_accounts where code = '4195'),
                  '（找不到 4195）'),
         case when (select book from public.payment_accounts where code = '4195') = 'aipi'
              then '✅' else '❌' end

  union all
  select 4, '★★★ ④ 1624 是洪鯊的嗎',
         coalesce((select book || '　' || name from public.payment_accounts where code = '1624'),
                  '（找不到 1624）'),
         case when (select book from public.payment_accounts where code = '1624') = 'hongsha'
              then '✅' else '❌' end

  union all
  /* ⑤ 兩筆新的現金帳號。★ 連「能不能收款」一起檢查 ——
       只檢查「在不在」的話，for_income 填錯會讓它出現在入款選單裡。 */
  select 5, '★★ ⑤ 兩筆現金帳號建好了嗎（而且只能付款）',
         coalesce((select string_agg(code || '(' || book || '・收'
                                     || case when for_income then '✓' else '✗' end
                                     || '・付' || case when for_payment then '✓' else '✗' end || ')',
                                     '、' order by code)
                     from public.payment_accounts where code in ('愛皮現金', '洪鯊現金')), '（都沒有）'),
         case when (select count(*) from public.payment_accounts
                     where code in ('愛皮現金', '洪鯊現金')
                       and for_income = false and for_payment = true) = 2
              then '✅ 兩筆都在，而且只能付款'
              else '❌' end

  union all
  /* ⑥ 有沒有漏網的 null 或怪值 —— not null ＋ check 應該讓它不可能發生，
       但「不可能發生」要有一列證明它真的沒發生。 */
  select 6, '⑥ 有沒有帳本是空的或不認得的',
         (select count(*)::text || ' 個'
            from public.payment_accounts
           where book is null or book not in ('anxing', 'aipi', 'hongsha')),
         case when (select count(*) from public.payment_accounts
                     where book is null or book not in ('anxing', 'aipi', 'hongsha')) = 0
              then '✅ 每一個都歸好了' else '❌' end

  union all
  /* ⑦ 約束在不在 */
  select 7, '⑦ pa_book_chk 這條約束在嗎',
         coalesce((select conname::text from pg_constraint
                    where conrelid = 'public.payment_accounts'::regclass
                      and conname::text = 'pa_book_chk'), '（不在）'),
         case when exists (select 1 from pg_constraint
                            where conrelid = 'public.payment_accounts'::regclass
                              and conname::text = 'pa_book_chk')
              then '✅' else '❌' end

  union all
  /* ⑧ 代號一個都沒被改到 —— 這一支的前提就是「不動代號」 */
  select 8, '★★ ⑧ 原本那 11 個代號還在嗎',
         (select count(*)::text || ' / 11'
            from public.payment_accounts
           where code in ('8088','0564','4145','2915','4175','安幸現金',
                          '正隆現金','9650','8311','4195','1624')),
         case when (select count(*) from public.payment_accounts
                     where code in ('8088','0564','4145','2915','4175','安幸現金',
                                    '正隆現金','9650','8311','4195','1624')) = 11
              then '✅ 一個都沒動' else '❌ 有代號不見了 —— 停下來' end

  union all
  /* ★★ 洪鯊還沒有資料是**正常的**（籌備處）—— 說出來，不判成錯 */
  select 8.5, 'ℹ ⑧b 洪鯊現在有資料了嗎',
         (select count(*)::text || ' 筆支出'
            from public.expenses where book = 'hongsha'),
         'ℹ 0 筆是正常的 —— 洪鯊是籌備處。這一列只是讓你知道現況'

  union all
  select 9, '⑨ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '284_account_book'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '284_account_book')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
