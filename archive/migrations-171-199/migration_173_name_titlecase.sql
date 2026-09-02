-- migration_173：人名統一成首字大寫
--
-- ============================================================
-- 【為什麼】（2026-08-24 使用者指定）
--
-- 搜尋「Lilian」找到四筆，四種寫法:
--
--     LILIAN        B8   時兆
--     Lilian        B6   時兆
--     Lilian Hong   B6   時兆
--     LILIAN WA     南京5 南京
--
-- 使用者:「幫我統一，輸入是首字大寫。資料庫也幫我修正。」
--
-- 大小寫不統一的代價不只是難看:客戶管理裡同一個人會出現好幾筆、
-- 搜尋「lilian hong」不一定找得到、對帳時「這兩筆是不是同一個人」要靠人記。
--
--
-- ============================================================
-- 【中文原樣保留 —— 「鎖英文輸入」不能照字面做】
--
-- 房客與廠商有大量中文名（洪國竣、時兆物業…）。
-- 真的鎖成只能打英文的話，那些名字存不進去。
--
-- 所以規則是:**ASCII 英文字母的詞首字大寫、其餘小寫，中文字不動**。
-- 中文本來就沒有大小寫，這樣兩種都統一了。
--
--
-- ============================================================
-- 【不做的事】
--
-- ★ 不還原 `LLC`、`ABC` 這種縮寫 —— 分不出來。
--   `LILIAN WA` 要變 `Lilian Wa`（使用者的例子），
--   而 `ABC 公司` 也會變成 `Abc 公司`。
--   要保留縮寫就得維護白名單，而白名單漏一個的症狀是
--   「某家廠商的名字每次存檔都被改掉」。
--   統一比正確重要 —— 因為統一才搜尋得到。
--
-- ★ 不自動合併相似的名字。系統負責看見，人負責決定
--   （CLAUDE.md 的判斷原則）。相似的在防呆裡提示（'姓名相似'）。
--
-- ★ **不動 `payee_name`（收款方）**。那是要跟銀行帳戶對得上的名字，
--   改成首字大寫可能就匯不出去。只動人名欄位。
--
--
-- ============================================================
-- 【前端也有一份一樣的邏輯】
--
-- `src/lib/name-format.ts` 的 `titleCaseName()`，22 個測試。
-- 兩邊必須一致 —— 不一致的話，畫面上顯示的跟存進去的不一樣，
-- 而使用者會以為自己打錯了。
-- 下面的自檢有一項就是對同一批例子驗證兩邊結果相同。
-- ============================================================


-- ============================================================
-- ① 正規化函式
-- ============================================================
create or replace function public.title_case_name(p_raw text)
returns text language plpgsql immutable as $function$
declare
  s     text;
  out_t text := '';
  ch    text;
  at_start boolean := true;
  i int;
begin
  if p_raw is null then return null; end if;

  /*
   * 空白收乾淨。**全形空白也要**（U+3000）——
   * 中文輸入法常打出來，不收的話兩筆看起來一樣卻不相等，
   * 而「看起來一樣卻不相等」正是這次要修的問題本身。
   */
  s := btrim(regexp_replace(p_raw, '[[:space:]　]+', ' ', 'g'));
  if s = '' then return ''; end if;

  for i in 1 .. length(s) loop
    ch := substr(s, i, 1);
    if ch ~ '[A-Za-z]' then
      out_t := out_t || case when at_start then upper(ch) else lower(ch) end;
      at_start := false;
    else
      out_t := out_t || ch;
      /*
       * ★ 分隔不只有空白 —— `-` `'` `.` 之後也要大寫
       *   （O'Brien、Anne-Marie、J.R.）。只看空白會得到 O'brien。
       * ★ 中文字之後也算詞的開頭:「王lilian」要得到大寫的 L。
       */
      at_start := true;
    end if;
  end loop;

  return out_t;
end $function$;

comment on function public.title_case_name(text) is
  '人名正規化:英文詞首字大寫、其餘小寫，中文原樣保留，空白收乾淨。'
  '★ 前端有一份一樣的（src/lib/name-format.ts 的 titleCaseName）—— '
  '兩邊必須一致，不然畫面顯示的跟存進去的會不一樣（migration_173）。';


-- ============================================================
-- ② 回填既有資料
-- ============================================================
create temp table _chk173 (ord int, item text, result text, note text) on commit drop;

/*
 * ★ 只改「真的不一樣」的那幾筆。
 *
 *   無條件全部回寫的話，四千多筆訂單的 updated_at 會全部變成今天，
 *   而「最近改過什麼」這個問題從此答不出來。
 *
 * ★ 不用分頁。Supabase 最多回 1000 列是 PostgREST 的限制，
 *   直接下 SQL 沒有這回事。
 */
with fix_orders as (
  update public.orders
     set guest_name = public.title_case_name(guest_name)
   where guest_name is not null
     and guest_name <> public.title_case_name(guest_name)
  returning id
),
fix_contracts as (
  update public.contracts
     set tenant_name = public.title_case_name(tenant_name)
   where tenant_name is not null
     and tenant_name <> public.title_case_name(tenant_name)
  returning id
)
/*
 * ★★ **不動 customers**（2026-08-24，第一次跑就被擋下來）:
 *
 *     ERROR: 客戶的姓名、房源、住宿起訖是從訂單與契約帶過來的，
 *            不能在這裡改。
 *     CONTEXT: PL/pgSQL function customers_guard() line 13
 *
 *   `customers` 是**衍生資料** —— 姓名由 `sync_customers()` 從
 *   orders.guest_name 與 contracts.tenant_name 重算出來（migration_105），
 *   而 `trg_customers_guard` 就是在守這件事。
 *
 *   所以正確的做法是改源頭（上面那兩張表），
 *   然後在下面重跑一次同步讓客戶清單跟上。
 *
 *   ★ 這也是為什麼 customers 上**沒有** a_norm_name 觸發器 ——
 *     加了會跟守衛打架，而且是多餘的:源頭乾淨了，衍生的自然乾淨。
 */
insert into _chk173
select 1, '★★ 這次改了幾筆',
       (select count(*) from fix_orders)::text || ' 筆訂單房客 ＋ '
       || (select count(*) from fix_contracts)::text || ' 筆契約承租人',
       '只改「原本就不一樣」的。客戶是衍生資料,下面重算';


-- ============================================================
-- ③ 觸發器：以後存進來的自動正規化
-- ============================================================
/*
 * 前端也會做一次，但前端擋不住:
 *   · 重新整理後的舊畫面
 *   · Airbnb 匯入（那是 service key，不走畫面）
 *   · 未來某個人寫的另一支程式
 *
 * 「這一欄長什麼樣」是資料的規則，不是畫面的規則。
 *
 * ★ 匯入**不放行**。這裡跟 migration_157 的鎖定守衛不同 ——
 *   那支是「防手滑」所以放行 service key；
 *   這支是「格式統一」，匯入進來的名字更需要統一
 *   （Airbnb 的房客名大小寫最亂）。
 */
create or replace function public.normalize_person_name()
returns trigger language plpgsql as $function$
begin
  if TG_TABLE_NAME = 'orders' then
    new.guest_name := public.title_case_name(new.guest_name);
  elsif TG_TABLE_NAME = 'contracts' then
    new.tenant_name := public.title_case_name(new.tenant_name);
  end if;
  /*
   * ★ 這裡**沒有 customers** —— 它的 name 是 sync_customers() 從
   *   訂單與契約重算的，而 trg_customers_guard 擋直接改。
   *   加進來會跟守衛打架，也沒有必要:源頭乾淨了，衍生的自然乾淨。
   */
  return new;
end $function$;

comment on function public.normalize_person_name() is
  '存進來的人名一律轉成首字大寫。前端也做一次,但前端擋不住舊畫面與匯入'
  '（migration_173）。';

/*
 * ★ 觸發器名字以 `a_` 開頭。
 *
 *   BEFORE 觸發器**按名字字母序**跑（README 9.2）。
 *   這支只是把欄位洗乾淨，應該在其他判斷之前跑完 ——
 *   排在後面的話，前面那些用 guest_name 做判斷的觸發器
 *   看到的會是還沒正規化的值。
 */
drop trigger if exists a_norm_name on public.orders;
create trigger a_norm_name before insert or update of guest_name on public.orders
  for each row execute function public.normalize_person_name();

drop trigger if exists a_norm_name on public.contracts;
create trigger a_norm_name before insert or update of tenant_name on public.contracts
  for each row execute function public.normalize_person_name();

-- customers 沒有觸發器 —— 見上面的說明


-- ============================================================
-- ④ 重算客戶清單
-- ============================================================
/*
 * 源頭（訂單、契約）洗乾淨了，衍生的 customers 要跟上。
 *
 * `sync_customers()` 是**手動觸發**的 RPC —— 客戶頁那顆「重新整理」按的就是它，
 * 沒有任何自動觸發器會呼叫它。不在這裡跑一次的話，
 * 客戶清單會停在舊的大小寫，而**沒有人會知道要去按那顆按鈕**。
 *
 * ★ 包在 exception 裡。同步失敗不該讓上面的回填一起回滾 ——
 *   那才是真正重要的部分，而客戶清單隨時可以再按一次重新整理。
 */
do $$
declare v_msg text;
begin
  begin
    perform public.sync_customers();
    v_msg := '✅ 已重算';
  exception when others then
    v_msg := '⚠ 沒跑成功:' || sqlerrm || ' —— 請到客戶頁按「重新整理」';
  end;
  insert into _chk173 values (3, '客戶清單重算', v_msg,
    'customers 是衍生資料,由 sync_customers() 從訂單與契約重算');
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('173_name_titlecase');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★★ 真的存一筆進去，看觸發器有沒有把它洗乾淨。
 *   只檢查「觸發器存在嗎」抓不到條件寫錯（167 / 164 都是那樣漏的）。
 */
do $$
declare v_id uuid; v_got text; v_msg text;
begin
  select id into v_id from public.orders limit 1;
  if v_id is null then
    insert into _chk173 values (2, '★★ 觸發器實測', '⚠ 測不出來', '一筆訂單都沒有');
    return;
  end if;

  begin
    update public.orders set guest_name = '  lilian   WA  ' where id = v_id
      returning guest_name into v_got;
    v_msg := case when v_got = 'Lilian Wa' then '✅ 存成「Lilian Wa」'
                  else '❌ 存成「' || coalesce(v_got, '(null)') || '」' end;
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    -- orders 上還有鎖定守衛等觸發器,丟的是 check_violation。
    -- 只抓一種的話會炸掉整份腳本（README 9.4 第 9 條）
    if sqlerrm <> '__rollback__' then v_msg := '⚠ 例外:' || sqlerrm; end if;
  end;

  insert into _chk173 values (2, '★★ 觸發器實測', coalesce(v_msg, '⚠ 沒跑到'),
    '輸入「  lilian   WA  」應該存成「Lilian Wa」');
end $$;


select "檢查項目", "結果", "說明" from (

  select c.ord, c.item as "檢查項目", c.result as "結果", c.note as "說明"
    from _chk173 c

  union all
  /*
   * ★★ 跟前端那份對答案。
   *    這幾組是 src/lib/name-format.test.ts 裡的同一批例子 ——
   *    兩邊不一致的話，畫面顯示的跟存進去的不一樣，
   *    而使用者會以為自己打錯了。
   */
  select 4, '★★ 與前端 titleCaseName 一致',
         case when bool_and(public.title_case_name(inp) = want)
              then '✅ ' || count(*)::text || ' / ' || count(*)::text
              else '❌ ' || string_agg(
                     case when public.title_case_name(inp) <> want
                          then inp || ' → ' || public.title_case_name(inp)
                               || '（應為 ' || want || '）' end, '；') end,
         '前端 name-format.ts 的同一批例子'
    from (values
      ('LILIAN', 'Lilian'),
      ('LILIAN WA', 'Lilian Wa'),
      ('Lilian Hong', 'Lilian Hong'),
      ('lilian hong', 'Lilian Hong'),
      ('洪國竣', '洪國竣'),
      ('王 lilian', '王 Lilian'),
      ('o''brien', 'O''Brien'),
      ('anne-marie', 'Anne-Marie'),
      ('  lilian   wa  ', 'Lilian Wa'),
      ('B8', 'B8')
    ) v(inp, want)

  union all
  /*
   * ★★ 回填完之後這個數字必須是 0。
   *   不是 0 表示還有沒洗乾淨的,而畫面上不會有任何提示。
   */
  select 5, '★★ 還有幾筆沒統一',
         (select count(*) from public.orders
           where guest_name is not null and guest_name <> public.title_case_name(guest_name))::text
         || ' 訂單 ／ '
         || (select count(*) from public.contracts
              where tenant_name is not null and tenant_name <> public.title_case_name(tenant_name))::text
         || ' 契約',
         '兩個都要是 0。客戶是衍生資料,看下一項'

  union all
  /*
   * ★ 名字統一之後，同一個人可能出現在多間房 —— 那正是防呆新增的
   *   「姓名相似」要抓的。這裡先給個數字讓人心裡有底。
   */
  select 6, '同名（統一後）出現在多間房的房客',
         count(*)::text || ' 個名字',
         '驗算模式的「姓名相似」會逐筆標出來'
    from (
      select guest_name
        from public.orders
       where guest_name is not null and btrim(guest_name) <> ''
         and coalesce(source, '') <> 'airbnb_cancelled'
       group by guest_name
      having count(distinct property_raw) > 1
    ) t

  union all
  /*
   * ★ 客戶清單同步之後也要乾淨。
   *   不是 0 的話表示 sync_customers 沒跑成功（看第 3 項）,
   *   或者它的名字來源不只 orders/contracts。
   */
  select 7, '★ 客戶清單還有幾筆沒統一',
         (select count(*) from public.customers
           where name is not null and name <> public.title_case_name(name))::text || ' 筆',
         '應為 0。不是的話請到客戶頁按「重新整理」再看一次'

  union all
  select 8, '兩支觸發器',
         (select count(*)::text || ' / 2' from pg_trigger
           where tgname = 'a_norm_name'
             and tgrelid in ('public.orders'::regclass,
                             'public.contracts'::regclass)),
         '訂單與契約。customers 沒有 —— 它是衍生資料,有守衛擋著'

) v order by ord;
