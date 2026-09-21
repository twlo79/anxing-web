/*
 * 查-帳號4195與1624用在哪裡.sql　2026-09-21
 * 只讀不寫。回一張表。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-21】
 *   「我要把帳號切出來，分成 安幸帳號／愛皮帳號／洪鯊帳號。
 *     24195 是愛皮的，1642 是洪鯊的。多創 愛皮現金、洪鯊現金。
 *     這動到主要是代墊 …… 需要先查 24195 有哪些有動到？」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼是「全庫掃描」而不是列幾張表】
 *
 * 畫面上那句話寫著「代號一旦有交易掛上就不要再改 —— 訂單與支出存的是代號」。
 * 但**到底有幾個地方存了代號**，我手上這份工作區只看得到一部分
 * （`payout_account`、`paid_account`、`refund_account`、`account`…）。
 *
 * 照記憶列一張表清單，漏掉的那一張**不會叫** —— 它會安靜地
 * 繼續指著一個已經改變意義的代號（README 坑 G）。
 * 所以這一支**問資料庫自己**:掃 public 底下每一個文字欄位，
 * 哪一欄真的有這幾個值就列出來。
 *
 * ★ 慢一點沒關係，它只跑一次，而且只讀。
 *
 * ══════════════════════════════════════════════════════════
 * 【要找的值】
 *   4195 / 24195   —— 畫面上「(愛皮)元大 24195」，代號欄是 4195
 *   1624 / 31624   —— 畫面上「(洪鯊-籌備處)玉山 3162…」，代號欄是 1624
 *
 * ★★ 兩種都找:代號欄是短的那個，但顯示名稱、備註、匯入的資料
 *   有可能存了長的那個。**少找一個看不出來，找多了一眼就分得掉。**
 *
 * ══════════════════════════════════════════════════════════
 * 【怎麼看結果】
 *   ① 先確認代號真的是 4195 / 1624（不是我看圖看錯）
 *   ② 哪些表的哪一欄用到 —— 這就是「改了會影響誰」的完整清單
 *   ③ 有 book 欄的那幾張，再切一次:**愛皮的帳號有沒有掛在安幸的資料上**
 *      —— 這一格是整件事的重點。有的話，那幾筆就是要先處理的。
 * ══════════════════════════════════════════════════════════
 */

-- ★★ temp table 不要加 on commit drop（README 二-3.7）——
--    SQL Editor 一句一個交易的話，加了就在下一句看不到它。
drop table if exists _hit;
drop table if exists _bk;
drop table if exists _fz;
drop table if exists _ld;
create temp table _hit (tbl text, col text, code text, n bigint);
create temp table _bk  (tbl text, col text, code text, book text, n bigint);
create temp table _fz  (tbl text, col text, code text, n bigint);   -- 包含式（參考用）
create temp table _ld  (acct text, for_book text, n bigint);        -- 現在的代墊是用誰的帳戶付的

do $do$
declare
  r      record;
  v_n    bigint;
  v_code text;
  v_has_book boolean;
  codes  text[] := array['4195', '24195', '1624', '31624'];
begin
  for r in
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       /* ★ 只掃真的表。view 掃了會重複算同一批資料，
          而重複的數字會讓人以為影響範圍比實際大。 */
       and t.table_type = 'BASE TABLE'
       and c.data_type in ('text', 'character varying', 'character')
     order by c.table_name, c.column_name
  loop
    foreach v_code in array codes loop
      execute format('select count(*) from public.%I where %I = $1',
                     r.table_name, r.column_name)
        into v_n using v_code;

      if v_n > 0 then
        insert into _hit values (r.table_name, r.column_name, v_code, v_n);

        /* ③ 這張表有沒有 book 欄 —— 有的話再切一次 */
        select exists (
          select 1 from information_schema.columns
           where table_schema = 'public' and table_name = r.table_name
             and column_name = 'book'
        ) into v_has_book;

        if v_has_book then
          execute format(
            'insert into _bk select %L, %L, %L, coalesce(book, ''(空的)''), count(*) '
            '  from public.%I where %I = $1 group by 1,2,3,4',
            r.table_name, r.column_name, v_code, r.table_name, r.column_name)
            using v_code;
        end if;
      end if;
    end loop;

    /*
     * ②b 包含式比對，**只找長的那兩個值**（24195 / 31624）。
     *
     * ★★ 為什麼不對短的（4195／1624）做包含式:
     *   '4195' 會掃到 '24195'、'314195'、任何含這四個數字的字串 ——
     *   誤報一多，整份清單就再也沒有人看（CLAUDE.md 判斷原則）。
     *   長的那兩個夠specific，掃到的幾乎一定是它本人。
     * ★ 這一段的結果標成「參考」，判斷還是看 ②。
     */
    foreach v_code in array array['24195', '31624'] loop
      execute format('select count(*) from public.%I where %I like $1',
                     r.table_name, r.column_name)
        into v_n using '%' || v_code || '%';
      if v_n > 0 then
        insert into _fz values (r.table_name, r.column_name, v_code, v_n);
      end if;
    end loop;
  end loop;

  /*
   * ④ 現在被標成「代墊」的暫付，是用**誰的帳戶**付出去的。
   *
   * ★★★ 這一格回答的是整件事的關鍵問題:
   *   新規則是「用安幸的帳戶付 → 才算代墊」。
   *   如果現在有代墊是用愛皮自己的帳戶付的，那筆在新規則下**不該是代墊** ——
   *   改之前要先知道有幾筆，不然改完那幾筆會突然變成孤兒。
   *
   * ★ 整段用 exists 包起來:欄位名跟我看到的不一樣時，
   *   這一段安靜跳過，不會把整支查詢炸掉。
   */
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='advance_payments'
                and column_name='paid_account')
     and exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='advance_payments'
                    and column_name='category')
     and exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='advance_payments'
                    and column_name='for_book')
  then
    insert into _ld
    select coalesce(a.paid_account, '(沒填)'),
           coalesce(a.for_book, '(沒填)'),
           count(*)
      from public.advance_payments a
     where a.category = '代墊'
     group by 1, 2;
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 結果
-- ★★ SQL Editor **只看得到最後一句**的結果（README 二-7.6）——
--    所以三段用 union all 併成一張表，不要分成三個 select。
-- ══════════════════════════════════════════════════════════
select * from (

  /* ── ① 帳號主檔（全部，因為要重新分組）───────────────── */
  select 1 as ord, '① 帳號主檔' as "段",
         p.code as "代號", p.name as "內容",
         coalesce(p.method, '—') as "細項",
         case when coalesce(p.active, true) then '' else '已停用' end as "欄位",
         '' as "筆數"
    from public.payment_accounts p

  union all
  select 2, '', '', '', '', '', ''

  union all
  /* ── ② 哪些表的哪一欄，值**就等於**這個代號 ──────────── */
  select 3, '② 誰用到了（完全相同）', h.code, h.tbl, '', h.col, h.n::text
    from _hit h

  union all
  /* ★★★ 一筆都沒有要**說出來** —— 空結果跟「沒查到」長得一樣 */
  select 3, '② 誰用到了（完全相同）', '（一個都沒有）',
         '⚠ 這四個值一個文字欄位都沒出現 —— 先確認代號對不對', '', '', '0'
   where not exists (select 1 from _hit)

  union all
  select 4, '', '', '', '', '', ''

  union all
  /* ── ③ 有 book 欄的再切一次：愛皮的帳號有沒有掛在安幸的資料上 ── */
  select 5, '③ 掛在哪一本帳', b.code, b.tbl, b.book, b.col, b.n::text
    from _bk b

  union all
  select 5, '③ 掛在哪一本帳', '（沒有）',
         'ℹ 用到這些代號的表都沒有 book 欄位', '', '', ''
   where not exists (select 1 from _bk)

  union all
  select 6, '', '', '', '', '', ''

  union all
  /* ── ④ 現在的代墊是用誰的帳戶付的（新規則的關鍵）───────── */
  select 7, '④ 現在的代墊用誰的帳戶付', l.acct, '代墊給 ' || l.for_book, '', '', l.n::text
    from _ld l

  union all
  select 7, '④ 現在的代墊用誰的帳戶付', '（一筆都沒有）',
         '⚠ 沒有任何 category = 代墊 的暫付 —— 下面的規則改動沒有舊資料要顧', '', '', '0'
   where not exists (select 1 from _ld)

  union all
  select 8, '', '', '', '', '', ''

  union all
  /* ── ②b 包含式（參考用，可能誤報）───────────────────── */
  select 9, 'ℹ 參考：字串裡含長號碼', f.code, f.tbl, '', f.col, f.n::text
    from _fz f

  union all
  select 9, 'ℹ 參考：字串裡含長號碼', '（沒有）',
         '沒有任何欄位的字串裡含 24195 / 31624', '', '', ''
   where not exists (select 1 from _fz)

) v(ord, "段", "代號", "內容", "細項", "欄位", "筆數")
order by v.ord, v."代號", v."內容", v."欄位";
