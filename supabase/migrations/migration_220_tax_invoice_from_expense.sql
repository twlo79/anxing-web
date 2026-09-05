/*
 * migration_220 —— 進項發票可以從支出帶入
 * ============================================================
 * 2026-09-05 使用者：「稅務管理可以從支出抓到進項，然後自動計算稅金」
 *                    「支出轉入要在同月」「要 mapping 資料庫」
 *
 * 這一支只準備資料庫這一半：一個關聯欄位、一個唯一索引、
 * 一個放寬的 check。**不搬任何一列資料**。
 *
 * ============================================================
 * 【★★★ 為什麼一定要 expense_id 這個欄位】
 *
 * 沒有它的話，「這筆支出帶過了沒」只能靠發票號碼去猜。
 * 而猜錯的方向是**同一筆進項被帶進來兩次** ——
 * 進項稅額憑空多一份，401 申報書上的應繳稅額就少繳了那一份。
 *
 * 帳面上看不出來:兩列的發票號碼一樣，但一列是 25 一列是 X，
 * 或者中間有人改過金額。而它只會讓「進項稅額」這個數字變大，
 * 沒有任何一個地方會叫。
 *
 * ★ `tax_invoice_uniq (company_tax_id, kind, invoice_no)` 擋得住
 *   「同一個發票號碼」，但擋不住「同一筆支出、號碼被改過」。
 *   而且它擋下來的方式是 on conflict —— 悄悄覆蓋，不是報錯。
 *
 * ============================================================
 * 【★★★ 外鍵一定是 ON DELETE SET NULL，不能是 CASCADE】
 *
 * CASCADE 的話:**刪掉一筆支出會連帶刪掉一張已申報的發票**。
 * 那張發票是真的開出來過的，它在財政部那邊有紀錄 ——
 * 這邊刪掉之後，已結算期別的申報數就對不回去了。
 *
 * 而刪支出是很日常的動作（打錯了、重複入帳）。
 * 那個人不會知道自己順手改了報稅的數字。
 *
 * SET NULL 的代價要知道:支出被刪之後那張發票變成沒有來源的孤兒，
 * 而它**可以被重新帶入一次**（唯一索引只管 not null 的）。
 * 那是可接受的 —— 發票號碼那條唯一約束會接住它。
 *
 * ★ 這跟 migration_219 那個 `purchase_demand_items.request_item_id`
 *   的 `on delete set null` 是同一個判斷:關聯斷掉可以，資料不能消失。
 *
 * ============================================================
 * 【怎麼算稅額（寫在這裡，程式碼照這個做）】
 *
 * `expenses.amount` 是**含稅**的實付金額（2026-09-05 使用者確認），
 * 而 `expenses` 沒有稅額欄、沒有未稅欄、也沒有賣方統編欄。
 *
 *   銷售額 = round(amount ÷ 1.05)
 *   稅額   = amount − 銷售額          ← 相減，不是各自四捨五入
 *   總金額 = amount
 *
 * ★★ 稅額用**相減**算。兩個都四捨五入的話 net + tax 可能不等於 total，
 *   而 `tax_invoice_amount_chk` 會擋下來,錯誤訊息看不懂。
 *
 * ★★★ 反推對「免稅」是錯的 —— 房租、保險、薪資、國外服務
 *   沒有 5% 進項稅，而反推照樣給它一個。
 *   緩衝有兩層:① 憑證號碼不合統一發票格式的預設稅碼 `X`、稅額 0、
 *   不預設勾；② 帶入前每一列的稅額都可以改。
 *   **這是預填，不是答案。**
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

-- ══════════════════════════════════════════════════════════
-- 1. 關聯欄位
-- ══════════════════════════════════════════════════════════
alter table public.tax_invoice
  add column if not exists expense_id uuid;

/*
 * ★ 外鍵分開加,而且用 exception 包住 ——
 *   欄位可能已經存在（重跑），而重複加外鍵會 duplicate_object。
 *   SQL Editor 把整份包在一個交易裡,任一錯誤全部回滾（CLAUDE.md）。
 */
do $do$ begin
  alter table public.tax_invoice
    add constraint tax_invoice_expense_fk
    foreign key (expense_id) references public.expenses(id)
    on delete set null;
exception when duplicate_object then null; end $do$;

comment on column public.tax_invoice.expense_id is
  '這張進項發票是從哪一筆支出帶進來的（migration_220）。'
  'null = 手 key 或上傳的,跟支出無關。'
  '★★★ 外鍵是 on delete set null —— 刪支出**不能**刪掉已申報的發票。'
  '★ 唯一索引 tax_invoice_expense_uniq 保證同一筆支出只會被帶入一次:'
  '帶兩次的話進項稅額憑空多一份,而 401 上只會顯示成「應繳比較少」。';

-- ══════════════════════════════════════════════════════════
-- ★★★ 2. 同一筆支出只能帶一次
-- ══════════════════════════════════════════════════════════
/*
 * 部分索引 —— 只管 not null 的那些。
 * 手 key 與上傳的發票 expense_id 都是 null,那些不該互相排擠。
 */
do $do$ begin
  create unique index tax_invoice_expense_uniq
    on public.tax_invoice (expense_id)
    where expense_id is not null;
exception when duplicate_table then null;
          when duplicate_object then null; end $do$;

-- ══════════════════════════════════════════════════════════
-- 3. source 多一個 'expense'
-- ══════════════════════════════════════════════════════════
/*
 * ★ 約束的名字**用查的，不要憑印象寫**。
 *   inline check 是 Postgres 自動命名的,而我沒看過它實際叫什麼
 *   （CLAUDE.md：憑印象寫既有函式的簽章）。
 *
 * ★★ 來源分得開才追得回去。三種來源的錯法完全不同:
 *   手 key 打錯字、上傳的檔對錯期、帶入的稅額是反推的。
 *   全部混成 'manual' 的話，之後查「這個數字哪來的」只能猜。
 */
do $do$
declare cn text;
begin
  select co.conname::text into cn
    from pg_constraint co
    join pg_class c on c.oid = co.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'tax_invoice'
     and co.contype::text = 'c'
     and pg_get_constraintdef(co.oid) ilike '%source%'
   limit 1;

  if cn is not null then
    execute format('alter table public.tax_invoice drop constraint %I', cn);
  end if;

  alter table public.tax_invoice
    add constraint tax_invoice_source_chk
    check (source in ('manual', 'upload', 'expense'));
end $do$;

comment on column public.tax_invoice.source is
  'manual = 手 key；upload = 上傳的 excel；expense = 從支出帶入（migration_220）。'
  '★ 三種來源的錯法不一樣 —— 帶入的稅額是用 amount ÷ 1.05 反推的,'
  '免稅品項會被算出一個不存在的稅額。查數字來源時要看得出是哪一種。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('220_tax_invoice_from_expense');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① expense_id 欄位在不在',
         coalesce((select data_type || case when is_nullable = 'YES' then '，可為 null' else '，NOT NULL ❌' end
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'tax_invoice'
                      and column_name = 'expense_id'), '（不存在）'),
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'tax_invoice'
                              and column_name = 'expense_id' and is_nullable = 'YES')
              then '✅ 可為 null（手 key 的發票沒有來源支出）'
              else '❌ 沒加成功或設成 NOT NULL，下面不用看' end

  union all
  /*
   * ★★★ 這一列最重要。CASCADE 的話刪一筆支出會刪掉一張已申報的發票,
   *   而已結算期別的數字就再也對不回去了 —— 沒有任何地方會叫。
   */
  select 2, '★★★ ② 外鍵是不是 ON DELETE SET NULL',
         coalesce((select pg_get_constraintdef(co.oid)
                     from pg_constraint co
                     join pg_class c on c.oid = co.conrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = 'tax_invoice'
                      and co.contype::text = 'f'
                      and co.conname::text = 'tax_invoice_expense_fk'), '（沒有這個外鍵）'),
         case when exists (select 1 from pg_constraint co
                            join pg_class c on c.oid = co.conrelid
                            join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relname = 'tax_invoice'
                             and co.conname::text = 'tax_invoice_expense_fk'
                             and co.confdeltype::text = 'n')
              then '✅ SET NULL —— 刪支出不會刪掉發票'
              else '❌ 不是 SET NULL。CASCADE 的話刪支出會刪掉已申報的發票' end

  union all
  -- ★★ 沒有這條索引的話，同一筆支出帶兩次 = 進項稅額憑空多一份
  select 3, '★★ ③ 同一筆支出只能帶一次的索引',
         coalesce((select indexdef from pg_indexes
                    where schemaname = 'public' and tablename = 'tax_invoice'
                      and indexname = 'tax_invoice_expense_uniq'), '（沒有）'),
         case when exists (select 1 from pg_indexes
                            where schemaname = 'public' and tablename = 'tax_invoice'
                              and indexname = 'tax_invoice_expense_uniq')
              then '✅ 帶兩次會被擋下來'
              else '❌ 沒建成功 —— 重複帶入不會有人發現' end

  union all
  select 4, '④ source 現在允許哪些值',
         coalesce((select pg_get_constraintdef(co.oid)
                     from pg_constraint co
                     join pg_class c on c.oid = co.conrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = 'tax_invoice'
                      and co.contype::text = 'c'
                      and pg_get_constraintdef(co.oid) ilike '%source%'), '（沒有 check）'),
         case when coalesce((select pg_get_constraintdef(co.oid)
                     from pg_constraint co
                     join pg_class c on c.oid = co.conrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = 'tax_invoice'
                      and co.contype::text = 'c'
                      and pg_get_constraintdef(co.oid) ilike '%source%'), '') ilike '%expense%'
              then '✅ 認得 expense'
              else '❌ 帶入時會撞 check，而訊息看不懂' end

  union all
  -- ★ 舊的兩筆手 key 進項不能被動到
  select 5, '★ ⑤ 既有的發票有沒有被動到',
         (select count(*)::text || ' 張發票，其中進項 '
                 || count(*) filter (where kind = 'in')::text || ' 張，'
                 || 'expense_id 有值的 ' || count(*) filter (where expense_id is not null)::text || ' 張'
            from public.tax_invoice),
         case when (select count(*) filter (where expense_id is not null)
                      from public.tax_invoice) = 0
              then '✅ 一列都沒動（這一支只建結構）'
              else '⚠ 已經有帶入過的 —— 這支跑過了？' end

  union all
  /*
   * ★★★ 母體要判定。這是「這個功能第一次用的時候會看到幾筆」——
   *   0 的話上面四條只驗到結構，沒有任何一筆資料證明過它。
   */
  select 6, '★★★ ⑥ 這一期（115年9-10月）可以帶入幾筆',
         (select count(*)::text || ' 筆有憑證號碼，其中格式像統一發票的 '
                 || count(*) filter (where voucher_no ~ '^[A-Za-z]{2}[0-9]{8}$')::text || ' 筆'
            from public.expenses
           where spent_on between date '2026-09-01' and date '2026-10-31'
             and coalesce(voucher_no, '') <> ''),
         case when (select count(*) from public.expenses
                     where spent_on between date '2026-09-01' and date '2026-10-31'
                       and coalesce(voucher_no, '') <> '') = 0
              then '⚠ 這一期還沒有帶得進來的支出 —— 拿上一期試（下一列）'
              else '✅ 有東西可以帶' end

  union all
  select 7, '⑦ 上一期（115年7-8月）可以帶入幾筆',
         (select count(*)::text || ' 筆有憑證號碼，其中像統一發票的 '
                 || count(*) filter (where voucher_no ~ '^[A-Za-z]{2}[0-9]{8}$')::text
                 || ' 筆（稅碼預設 25）、不像的 '
                 || count(*) filter (where voucher_no !~ '^[A-Za-z]{2}[0-9]{8}$')::text
                 || ' 筆（稅碼預設 X、稅額 0、不預設勾）'
            from public.expenses
           where spent_on between date '2026-07-01' and date '2026-08-31'
             and coalesce(voucher_no, '') <> ''),
         'ℹ 這兩個數字就是畫面上會看到的兩組'

  union all
  -- ★ 統編走 expenses.request_id → purchase_requests.payee_tax_id
  select 8, '⑧ 有多少筆帶得到廠商統編',
         (select count(*)::text || ' 筆接得到請款單，其中請款單有填統編的 '
                 || count(*) filter (where coalesce(pr.payee_tax_id, '') <> '')::text || ' 筆'
            from public.expenses e
            join public.purchase_requests pr on pr.id = e.request_id
           where e.spent_on between date '2026-07-01' and date '2026-08-31'
             and coalesce(e.voucher_no, '') <> ''),
         'ℹ 接不到的統編欄會是空的,要人自己補'

  union all
  select 9, '⑨ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '220_tax_invoice_from_expense'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '220_tax_invoice_from_expense')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
