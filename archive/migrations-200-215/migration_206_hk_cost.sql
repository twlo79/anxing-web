/*
 * migration_206 —— 房務成本：清潔費單價、人事費、支出標籤
 * ============================================================
 * 2026-09-02 使用者：「我現在要自動 把清潔計算成支出」
 *
 * 這一支**只建欄位與種子**，不產生任何一筆支出。
 * 產生的動作在畫面上按（下一步做），因為那是錢的事 ——
 * CLAUDE.md:「建議，不自動」。
 *
 * ============================================================
 * 【★★★ 合掃算一份，不是兩份】（2026-09-02 使用者確認）
 *
 * 站上同一件事本來就有兩種算法（`lib/hk-payroll.ts` 的檔頭）:
 *
 *   打掃量  兩人合掃 → 各 0.5   給算薪用
 *   布巾    兩人合掃 → 算 1 組  給叫貨用
 *
 * ★ 清潔費是**付出去的錢**，跟布巾同一邊:房間只被清了一次。
 *   用打掃量那套的話，正隆一間合掃就會付兩次 —— 一次 9,000。
 *
 * ★★ 所以產生的單位是「一份工」＝ 同一天、同一房源、同一工作類型，
 *   不管幾個人做。這一條寫在 `lib/hk-cost.ts` 並且有測試。
 *
 * ============================================================
 * 【★★★ 冪等靠唯一索引，不靠前端記得】
 *
 * 沒有它的話，「產生本月支出」按兩次就是兩份帳 ——
 * 而**帳上多一筆看起來完全正常**，沒有任何地方會叫
 * （跟 advance_payments.forfeit_expense_id 同一個道理）。
 *
 *   清潔費  hk_job_key   = 日期|房源|工作類型
 *   人事費  hk_labor_key = 月份|對象
 *
 * ★ 用**部分**唯一索引（`where ... is not null`）——
 *   既有的 134 筆支出這兩欄都是 null，不受影響。
 */

-- ══════════════════════════════════════════════════════════
-- ① 清潔費單價（寫在房源上）
-- ══════════════════════════════════════════════════════════
alter table public.properties
  add column if not exists clean_price numeric(12,2);

comment on column public.properties.clean_price is
  '清潔費公訂價，每一份工多少錢（migration_206）。null = 還沒設。'
  '★★ null 的**不產生支出**，而且會列在產生預覽的「沒設單價」那一區 —— '
  '當成 0 的話帳會少一截，而沒有人會發現。'
  '★ 跟 clean_points 不同:points 是給算薪的難度分，price 是付出去的錢。';

/*
 * 種子（2026-09-02 使用者給的公訂價）。
 *
 * ★★ 正隆與時兆是**整個物業一個價**，所以照 estate 下去刷。
 *   其餘是指名到房源的。
 *
 * ★ `where clean_price is null` —— 已經有值的不覆蓋。
 *   重跑這支不會把使用者後來改的價格洗掉。
 */
update public.properties p set clean_price = 9000
  from public.estates e where e.id = p.estate_id
   and e.name = '正隆' and p.clean_price is null;

update public.properties p set clean_price = 730
  from public.estates e where e.id = p.estate_id
   and e.name = '時兆' and p.clean_price is null;

update public.properties set clean_price = v.price
  from (values
    ('台1+2', 2000), ('台4', 1000), ('804', 800),
    ('JPR1F', 2500), ('JPR2F', 2500),
    ('開封2-1', 2500), ('開封2-2', 10000), ('開封3F', 2500), ('開封4F', 3000)
  ) as v(name, price)
 where public.properties.name = v.name
   and public.properties.clean_price is null;


-- ══════════════════════════════════════════════════════════
-- ② 人事費（月固定）
-- ══════════════════════════════════════════════════════════
/*
 * ★★★ 為什麼是新的一張表，不是 `properties` 的一個欄位。
 *
 *   開封是**每個房源**各一個金額（1F-1 4000、2-1 12000…）
 *   正隆是**整個物業**一個 200,000
 *
 *   正隆沒有「整棟」那個房源，所以 200,000 塞不進任何一列 properties。
 *   硬要塞就得挑一間房來背 —— 而那間房的支出會憑空多二十萬。
 */
create table if not exists public.hk_labor_cost (
  id         uuid primary key default gen_random_uuid(),
  estate_id  uuid references public.estates(id)    on delete cascade,
  property_id uuid references public.properties(id) on delete cascade,
  monthly_amount numeric(12,2) not null,
  note       text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),

  -- ★ 只能擇一。兩個都填的話，同一筆錢會同時掛在物業與房源上
  constraint hklc_target_chk check (
    (estate_id is null) <> (property_id is null)),
  constraint hklc_amount_chk check (monthly_amount > 0)
);

comment on table public.hk_labor_cost is
  '房務人事費（月固定，migration_206）。estate_id 與 property_id 擇一。'
  '★ 產生的支出日期是**該月最後一天**（2026-09-02 使用者指定）。'
  '★★ 停用（active=false）就不再產生，但既有的支出不會消失 —— '
  '錢付了就是付了，不該因為改設定而從帳上不見。';

-- ★ 同一個對象只能有一列在用。兩列的話每個月會產生兩筆
create unique index if not exists hklc_estate_uniq
  on public.hk_labor_cost (estate_id) where active and estate_id is not null;
create unique index if not exists hklc_property_uniq
  on public.hk_labor_cost (property_id) where active and property_id is not null;

/*
 * 種子。開封那五個用**ERP 的名字**（2026-09-02 使用者:「開封 改成 ERP 的」，
 * 並且指定「2F-1 → 開封2-1」）。
 *
 * ★ 開封1F → 開封1F-1（ERP 裡只有這一個 1F）
 *   2F-2 → 開封2-2、3F → 開封3F、4F → 開封4F
 *   ★★ 開封2F **沒有**人事費 —— 使用者的清單裡沒有它。
 */
insert into public.hk_labor_cost (property_id, monthly_amount, note)
select p.id, v.amt, '房務人事費（migration_206 種子）'
  from (values
    ('開封1F-1', 4000), ('開封2-1', 12000), ('開封2-2', 8000),
    ('開封3F', 12000), ('開封4F', 12000)
  ) as v(name, amt)
  join public.properties p on p.name = v.name
 where not exists (select 1 from public.hk_labor_cost x
                    where x.property_id = p.id and x.active);

insert into public.hk_labor_cost (estate_id, monthly_amount, note)
select e.id, 200000, '房務人事費（migration_206 種子）'
  from public.estates e
 where e.name = '正隆'
   and not exists (select 1 from public.hk_labor_cost x
                    where x.estate_id = e.id and x.active);


-- ══════════════════════════════════════════════════════════
-- ③ 會計科目：房務清潔
-- ══════════════════════════════════════════════════════════
/*
 * ★ **新開一個**，不沿用既有的 `cleaning 清潔費`（2026-09-02 使用者:「新創」）。
 *   兩者性質不同:cleaning 是向房客收的清潔費（收入那邊在用），
 *   這個是我們付出去的房務成本。混在一起的話，
 *   報表上「清潔費」會同時包含收進來與付出去的錢。
 */
insert into public.account_codes (code, name, sort, active, kind) values
  ('hk_cleaning', '房務清潔', 155, true, 'expense')
on conflict (code) do update set
  name = excluded.name, kind = excluded.kind, active = true;


-- ══════════════════════════════════════════════════════════
-- ④ 支出：標籤 ＋ 冪等鍵
-- ══════════════════════════════════════════════════════════
alter table public.expenses
  add column if not exists tags text[] not null default '{}',
  add column if not exists hk_job_key   text,
  add column if not exists hk_labor_key text;

comment on column public.expenses.tags is
  '標籤（migration_206）。房務產生的支出帶 {房務}。'
  '★ 用 text[] 不用另開一張表:標籤只拿來篩選與顯示，不需要自己的屬性。'
  '要做標籤主檔（顏色、排序）時再拆。';
comment on column public.expenses.hk_job_key is
  '房務清潔費的冪等鍵:日期|房源|工作類型（migration_206）。'
  '★★★ 沒有它的話「產生本月支出」按兩次就是兩份帳，'
  '而帳上多一筆看起來完全正常，沒有任何地方會叫。';
comment on column public.expenses.hk_labor_key is
  '房務人事費的冪等鍵:月份|對象（migration_206）。同上。';

/*
 * ★ **部分**唯一索引 —— 既有的 134 筆這兩欄都是 null，
 *   而 Postgres 的唯一索引不管 null，所以不受影響。
 */
create unique index if not exists expenses_hk_job_uniq
  on public.expenses (hk_job_key) where hk_job_key is not null;
create unique index if not exists expenses_hk_labor_uniq
  on public.expenses (hk_labor_key) where hk_labor_key is not null;

create index if not exists expenses_tags_idx on public.expenses using gin (tags);


-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('206_hk_cost');
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★ 基準值不依賴這支改了什麼:第 ⑥ 列問的是「產生了幾筆支出」，
--   而這支一筆都不產生，正確答案永遠是 0。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★ ① 清潔費單價種好了',
         (select string_agg(x.line, E'\n' order by x.nm) from (
            select coalesce(e.name, '（無物業）') nm,
                   coalesce(e.name, '（無物業）') || '：'
                     || count(*) filter (where p.clean_price is not null)::text
                     || ' / ' || count(*)::text || ' 間有單價'
                     || case when count(*) filter (where p.clean_price is not null) = 0
                             then '' else '（'
                               || string_agg(distinct p.clean_price::text, '、')
                                    filter (where p.clean_price is not null) || '）' end as line
              from public.properties p
              left join public.estates e on e.id = p.estate_id
             where p.active
             group by e.name
          ) x),
         '★ 正隆該是 9000、時兆 730。沒設的**不會產生支出**，'
           || '而且會列在產生預覽裡（使用者:「沒關係」）'

  union all
  select 2, '★★★ ② 人事費六筆',
         (select string_agg(
                   coalesce(pr.name, e.name, '?') || '　' || c.monthly_amount::text,
                   E'\n' order by coalesce(pr.name, e.name))
            from public.hk_labor_cost c
            left join public.properties pr on pr.id = c.property_id
            left join public.estates    e  on e.id = c.estate_id
           where c.active),
         '★ 要看到 開封1F-1 4000、開封2-1 12000、開封2-2 8000、'
           || '開封3F 12000、開封4F 12000、正隆 200000。'
           || '★★ 開封2F 沒有人事費 —— 你的清單裡沒有它，我沒有自己補'

  union all
  select 3, '③ 人事費合計',
         (select '每月 ' || coalesce(sum(monthly_amount), 0)::text
            from public.hk_labor_cost where active),
         '★ 應該是 248,000'

  union all
  select 4, '★★★ ④ 冪等索引都在',
         (select case when count(*) = 2 then '✅ 兩個唯一索引都建了'
                      else '⚠⚠⚠ 只有 ' || count(*)::text
                           || ' 個 —— 產生支出按兩次會變成兩份帳' end
            from pg_indexes
           where schemaname = 'public'
             and indexname in ('expenses_hk_job_uniq', 'expenses_hk_labor_uniq')),
         '★★ 這是全支最重要的一條。重複的支出帳上看起來完全正常'

  union all
  select 5, '⑤ 科目與標籤欄位',
         (select (select coalesce(max(code || ' ' || name || ' kind=' || kind), '⚠ 沒有')
                    from public.account_codes where code = 'hk_cleaning')
                 || E'\n標籤欄位：'
                 || (select case when count(*) = 3 then '✅ tags／hk_job_key／hk_labor_key'
                                 else '⚠ 只有 ' || count(*)::text || ' 個' end
                       from information_schema.columns
                      where table_schema = 'public' and table_name = 'expenses'
                        and column_name in ('tags', 'hk_job_key', 'hk_labor_key'))),
         '★ 房務清潔是**新開的科目**，不沿用 cleaning（那個是向房客收的）'

  union all
  select 6, '★★★ ⑥ 一筆支出都沒產生',
         (select count(*)::text || ' 筆支出（房務產生的：'
                 || count(*) filter (where hk_job_key is not null
                                        or hk_labor_key is not null)::text || '）'
            from public.expenses),
         '★★★ 這支**只建欄位與種子**。房務產生的那個數字現在必須是 0 —— '
           || '產生的動作在畫面上按'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
