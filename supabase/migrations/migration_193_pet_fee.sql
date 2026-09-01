/*
 * migration_193 —— 寵物押金／寵物費：每個物業的預設金額，與押金的「項目」
 * ============================================================
 * 2026-09-01 使用者：「加入押金 押金項目 - 可以填 寵物 > 暫收管理 > 收退款」
 *                     「時兆 寵物押金 $10000 / 正隆 $30000 對應房源，可自動填入」
 *                     「JPR 寵物費$1500 | 時兆 $1000 | 開封 不能帶寵物入住 | 亞曼尼 $1500」
 *
 * ============================================================
 * 【★★★ 金額為什麼放資料庫而不是寫在程式裡】
 *
 * 寫成 `const PET_DEPOSIT = { 時兆: 10000, ... }` 是最快的做法，
 * 而且今天的行為完全一樣。但漲價那天要**改程式、跑 CI、部署** ——
 * 一個數字的異動變成一次發版。
 *
 * ★ 放資料庫的話，之後在設定頁改一個欄位就好，
 *   而且改了誰改的、什麼時候改的都留得下來。
 *
 * ============================================================
 * 【★★★ 「禁止帶寵物」不是金額 0】
 *
 * 開封不能帶寵物入住。如果用 `pet_deposit = 0` 表示，那跟
 * 「可以帶，但不收押金」長得一模一樣 —— 而畫面上要據此決定
 * 下拉裡**出不出現**「寵物押金」這個選項，兩者的行為完全相反。
 *
 *   pet_allowed = false   → 下拉裡根本沒有寵物押金／寵物費
 *   pet_allowed = true，金額 null → 有選項，但不自動帶入（要自己打）
 *   pet_allowed = true，金額有值 → 有選項，自動帶入並上鎖
 *
 * ★ 台視、復興**不建列** —— 沒有列 = 還沒設定，跟「設定成 0」是兩件事。
 *   猜一個 0 進去，之後沒有人知道那是設定過的還是預設的。
 *
 * ============================================================
 * 【★★★ 為什麼 item 加在 deposits 而不是 orders】
 *
 * `src/lib/money-lines.ts` 的 `fromLines()` 把畫面上**所有台幣列加總成
 * 一個數字**存進 `orders.deposit`。所以「一般押金 100,000 ＋ 寵物押金 30,000」
 * 走 orders 的話會變成 `deposit = 130,000`，項目在存檔那一刻就消失。
 *
 * ★ 而押金管理頁本來就是**一列一筆**在管收退 ——
 *   寵物押金天生就該是 `deposits` 裡獨立的一列，收退狀態各走各的
 *   （一般押金退了，寵物押金可能因為抓壞沙發沒退）。
 *
 * ⚠ 有一件事這支查不出來:訂單→deposits 的同步寫在 migration_56，
 *   那支不在 repo 裡。**自檢 ⑤⑥⑦ 會把它印出來** ——
 *   如果那個 trigger 會刪掉「orders.deposit 對不上的列」，
 *   人工加的寵物押金會被它清掉，那前端就得改走別的寫入路徑。
 *   先看到再決定，不猜。
 */

-- ══════════════════════════════════════════════════════════
-- ① 每個物業的寵物預設
-- ══════════════════════════════════════════════════════════
create table if not exists public.estate_fee_default (
  estate_id   uuid primary key references public.estates(id) on delete cascade,
  /*
   * ★ 禁止與未設定是兩件事（見上方說明）。
   *   not null default true —— 沒特別講的物業一律「可以帶」，
   *   而金額 null 表示還沒設定，畫面上不自動帶入。
   */
  pet_allowed boolean not null default true,
  pet_deposit numeric(14,2),
  pet_fee     numeric(14,2),
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  /*
   * ★★ 禁止帶寵物就不該有金額 —— 兩個欄位互相矛盾的資料
   *   在畫面上會變成「下拉裡沒有這個選項，但資料庫裡躺著一個金額」，
   *   而那個金額之後會有人拿去用。
   */
  constraint efd_ban_no_amount_chk check (
    pet_allowed or (pet_deposit is null and pet_fee is null)
  ),
  constraint efd_nonneg_chk check (
    coalesce(pet_deposit, 0) >= 0 and coalesce(pet_fee, 0) >= 0
  )
);

comment on table public.estate_fee_default is
  '每個物業的寵物押金／寵物費預設金額（migration_193）。'
  '★ 沒有列 = 還沒設定，跟「設定成 0」是兩件事。'
  '★ pet_allowed=false = 禁止帶寵物，下拉裡不出現該選項 —— 不是金額 0。';

comment on column public.estate_fee_default.pet_allowed is
  'false = 這個物業禁止帶寵物入住，押金項目與加費選單都不出現寵物那兩項。';
comment on column public.estate_fee_default.pet_deposit is
  '寵物押金預設金額。null = 未設定（有選項但不自動帶入，要自己打）。';
comment on column public.estate_fee_default.pet_fee is
  '寵物費（一次性收入）預設金額。null = 未設定。';

alter table public.estate_fee_default enable row level security;

/*
 * ★ RLS：跟其他主檔一致 —— 登入的人都看得到，只有 admin 改得動。
 *   包在 exception 裡是因為 SQL Editor 把整份腳本當**一個交易**，
 *   policy 已存在會讓整支回滾（CLAUDE.md 的坑）。
 */
do $$ begin
  begin
    create policy efd_read on public.estate_fee_default
      for select to authenticated using (true);
  exception when duplicate_object then null; end;

  begin
    create policy efd_write on public.estate_fee_default
      for all to authenticated
      using (public.current_role_of() = 'admin')
      with check (public.current_role_of() = 'admin');
  exception when duplicate_object then null; end;
end $$;


-- ══════════════════════════════════════════════════════════
-- ② 押金的「項目」
-- ══════════════════════════════════════════════════════════
alter table public.deposits
  add column if not exists item text;

comment on column public.deposits.item is
  '押金項目（migration_193）。null = 一般押金（既有資料一律如此，**不回填**）。'
  '★ 不回填的理由：回填之後就分不出「使用者真的選了一般押金」與'
  '「這是 migration 之前的舊資料」—— 而那兩件事在追查時是不同的線索。';

/*
 * ★ 值域用 check 擋住，不用 enum ——
 *   enum 加一個值要 `alter type`，而那在交易裡有限制。
 *   之後要多一種押金項目，改這個 check 就好。
 */
do $$ begin
  begin
    alter table public.deposits
      add constraint dep_item_chk check (item is null or item in ('一般押金', '寵物押金'));
  exception when duplicate_object then null; end;
end $$;


-- ══════════════════════════════════════════════════════════
-- ③ 預設值。★ 用物業**名稱**對，對不到的**不建列**（不猜）
-- ══════════════════════════════════════════════════════════
insert into public.estate_fee_default (estate_id, pet_allowed, pet_deposit, pet_fee)
select e.id, s.allowed, s.dep, s.fee
  from (values
    ('時兆',   true,  10000::numeric, 1000::numeric),
    ('正隆',   true,  30000::numeric, 3000::numeric),
    ('JPR',    true,  10000::numeric, 1500::numeric),
    ('亞曼尼', true,  10000::numeric, 1500::numeric),
    ('開封',   false, null::numeric,  null::numeric)
  ) as s(nm, allowed, dep, fee)
  join public.estates e on e.name = s.nm
on conflict (estate_id) do nothing;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('193_pet_fee');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回一張表。
-- ★ 排序欄留在子查詢（`v.ord`）—— `order by 1` 會照文字排（migration_181 踩過）。
-- ★ 基準值不依賴這支改的東西（migration_187／191 踩過）——
--   ①⑤⑥⑦ 讀的是 migration_56 建的舊結構，這支一個字都沒動它。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ 五個物業都對上了嗎',
         (select case when count(*) = 5
                      then '✅ 5 個全部建好'
                      else '⚠ 只建了 ' || count(*) || ' 個，缺:'
                           || (select string_agg(s.nm, '、')
                                 from (values ('時兆'),('正隆'),('JPR'),('亞曼尼'),('開封')) s(nm)
                                where not exists (
                                  select 1 from public.estate_fee_default d
                                    join public.estates e on e.id = d.estate_id
                                   where e.name = s.nm)) end
            from public.estate_fee_default),
         '★ 缺的是**物業名稱對不上** —— 看第 2 列的實際名稱，告訴我正確的寫法，'
           || '我補一支 migration。★ 不自動模糊比對:對錯一個，那個物業的押金金額就全錯'

  union all
  select 2, '物業主檔的實際名稱',
         (select string_agg(name, '、' order by sort, name) from public.estates where active),
         '第 1 列說缺哪個的話，從這裡找它真正的名字'

  union all
  select 3, '★ 建好的預設值',
         (select string_agg(
                   e.name || '：'
                   || case when not d.pet_allowed then '禁止帶寵物'
                           else '押金 ' || coalesce(d.pet_deposit::text, '未設定')
                                || ' ／ 費用 ' || coalesce(d.pet_fee::text, '未設定') end,
                   E'\n' order by e.sort, e.name)
            from public.estate_fee_default d join public.estates e on e.id = d.estate_id),
         '要看到 時兆 10000/1000、正隆 30000/3000、JPR 10000/1500、'
           || '亞曼尼 10000/1500、開封 禁止'

  union all
  select 4, '★★ deposits.item 加好了、舊資料沒被動到',
         (select case when count(*) filter (where item is not null) = 0
                      then '✅ 欄位存在，' || count(*) || ' 筆舊押金的 item 全是 null（正確，不回填）'
                      else '⚠ 有 ' || count(*) filter (where item is not null)
                           || ' 筆已經有值 —— 這支不該寫任何 item' end
            from public.deposits),
         '★ null = 一般押金。回填的話就分不出「使用者選的」與「舊資料」'

  union all
  /*
   * ★★★ 這三列是**設計前置查證**，不是驗證這支做對了。
   *   訂單→deposits 的同步在 migration_56，那支不在 repo 裡。
   *   如果它會刪掉「orders.deposit 對不上的列」，人工加的寵物押金會被清掉。
   */
  select 5, '★★★ 【要看】orders 上的 trigger',
         coalesce((select string_agg(t.tgname || ' → ' || p.proname || '()', E'\n' order by t.tgname)
                     from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                    where t.tgrelid = 'public.orders'::regclass and not t.tgisinternal),
                  '（沒有）'),
         '★ 名字裡有 deposit 的要特別看 —— 它可能會覆寫或刪掉押金列'

  union all
  /*
   * ★★★ `prokind in ('f','p')` 不能省（2026-09-01 踩過）。
   *
   *   `pg_get_functiondef()` 傳進**聚合函式**的 oid 會直接報錯:
   *     ERROR: 42809: "array_agg" is an aggregate function
   *
   *   而 `pg_proc` 裡混著一般函式（f）、聚合（a）、window（w）、procedure（p）。
   *   不過濾的話這一行會掃到 array_agg 然後整支 migration 回滾 ——
   *   **而爆掉的是自檢，不是要做的事**。
   *
   * ★ 順序也有關係:PostgreSQL 不保證 where 的求值順序，
   *   所以不能指望「prokind 那個條件先擋掉」。這裡靠的是
   *   prokind 直接把聚合排除在掃描範圍外。
   */
  select 6, '★★★ 【要看】會動到 deposits 的函式',
         coalesce((select string_agg(p.proname || '()', E'\n' order by p.proname)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.prokind in ('f', 'p')
                      and pg_get_functiondef(p.oid) ilike '%public.deposits%'
                      and pg_get_functiondef(p.oid) ~* '(insert|update|delete)'),
                  '（沒有）'),
         '★ 前端要不要自己寫 deposits，取決於這裡面有沒有人在替訂單維護押金列'

  union all
  select 7, '★★ 【要看】deposits 的唯一索引',
         coalesce((select string_agg(indexname, E'\n' order by indexname)
                     from pg_indexes
                    where schemaname = 'public' and tablename = 'deposits'
                      and indexdef ilike '%unique%'),
                  '（沒有唯一索引）'),
         '★ 如果有 (order_id, currency) 的唯一索引，同一張訂單就放不下'
           || '「一般押金 TWD」＋「寵物押金 TWD」兩列 —— 那要改成含 item 的索引'

  union all
  select 8, '既有資料沒動',
         (select (select count(*) from public.deposits)::text || ' 筆押金 ／ '
                 || (select count(*) from public.orders)::text || ' 筆訂單 ／ '
                 || (select count(*) from public.estates)::text || ' 個物業'),
         '這支只建一張新表、加一個欄位，一筆既有資料都不該動'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
