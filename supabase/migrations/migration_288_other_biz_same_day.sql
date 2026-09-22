/* ══════════════════════════════════════════════════════════════════════
 * migration_288  其他收支帳的收入存得進去                    2026-09-22
 *
 * 症狀（使用者 2026-09-22）：
 *   其他收支帳 → 愛皮 → 新增收入 → 儲存
 *   → new row for relation "orders" violates check constraint
 *     "ord_stay_nights_chk"
 *
 * 原因：
 *   一次性收入沒有住宿，前端寫成「入住 ＝ 退房 ＝ 那一天、nights = 0」
 *   （otherbooks/page.tsx `saveIncome`）。而那條約束是：
 *
 *     CHECK (checkin IS NULL OR checkout IS NULL
 *            OR source = ANY (ARRAY['oneoff','airbnb_cancelled'])
 *            OR checkout > checkin)
 *
 *   —— 不是住宿的來源可以同一天，**而 `other_biz` 不在那張名單裡**。
 *   那張名單是在 `other_biz` 這個來源還不存在的時候寫的。
 *
 * ★★★ 這支只做一件事：把 `other_biz` 加進那張例外名單。
 *   跟 `oneoff` 同一類 —— 都是「有錢、沒有住宿」。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼不是改前端】
 *
 *   把退房改成「那一天 ＋ 1」可以繞過去，但那是**在資料裡寫一個
 *   不存在的住宿**。愛皮的「前期餘額」沒有人住過任何一晚。
 *   一旦寫進去，以後任何數住宿天數的查詢都會把它算進來，
 *   而畫面上完全看不出來。
 *
 * 【為什麼不是放寬成「所有來源都可以同一天」】
 *
 *   那條規則對真的住宿單是有用的 —— 匯入時把退房打成跟入住同一天
 *   是常見的打錯，而它會讓那張單的營收認列變成 0 元。
 *   規則要留著，只是名單要補。
 *
 * ══════════════════════════════════════════════════════════
 * 【查過的（2026-09-22，在線上）】
 *
 *   ord_stay_nights_chk  定義如上，`NOT VALID`
 *   ord_dates_chk        `checkout >= checkin` —— 同一天本來就過得了
 *   orders_purpose_chk   `purpose_type` 已經收 'other_biz'
 *   同一天 ＋ nights=0    線上已經有 **450 筆**，全部是 `oneoff`，
 *                        證明「同一天、住 0 晚」這個形狀本身是合法的
 *
 * ★ 維持 `NOT VALID`：舊約束本來就是 NOT VALID（既有列沒被驗過）。
 *   這支是**放寬**（多一個 OR 分支），原本過得了的列一定還過得了；
 *   但改成 VALID 會去驗那些從來沒驗過的舊列，可能在無關的地方炸掉。
 *   行為維持原樣，不趁機夾帶。
 *
 * ★★ 自檢在 commit 後面 —— **看不到那張表就是整支回滾了**，
 *   不是「跑成功但沒輸出」。
 * ══════════════════════════════════════════════════════════════════════ */

/*
 * ★ 自檢用的暫存表建在交易**外面**（跟 migration_257 同一個理由）：
 *   建在裡面的話，自檢沒過而整支回滾時這張表也跟著消失，
 *   最後那段 select 會變成「relation does not exist」——
 *   而那句錯誤會蓋掉我真正想讓人看到的失敗原因。
 */
create temp table if not exists _m288_probe (ok boolean, msg text);
truncate _m288_probe;

begin;

-- ── ① 換掉那條約束 ────────────────────────────────
alter table public.orders drop constraint if exists ord_stay_nights_chk;

alter table public.orders add constraint ord_stay_nights_chk
  check (
    checkin is null
    or checkout is null
    or source = any (array['oneoff'::text, 'airbnb_cancelled'::text, 'other_biz'::text])
    or checkout > checkin
  ) not valid;

/* ★ 舊定義留底。一條看門的規則被換掉而沒有人知道它原本長什麼樣，
     比留著它更糟（2026-09-10 的教訓）。 */
comment on constraint ord_stay_nights_chk on public.orders is
  '住宿單的退房必須晚於入住。不是住宿的來源（oneoff／airbnb_cancelled／other_biz）除外。'
  '　migration_288 之前的定義：CHECK (checkin IS NULL OR checkout IS NULL '
  'OR source = ANY (ARRAY[''oneoff''::text, ''airbnb_cancelled''::text]) OR checkout > checkin) '
  '—— 少了 other_biz，愛皮／洪鯊的一次性收入一筆都存不進去（2026-09-22）。';

-- ── ② commit 之前先確認約束真的換好了 ──────────────
do $do$
declare d text;
begin
  select pg_get_constraintdef(con.oid) into d
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'orders'
     and con.conname = 'ord_stay_nights_chk';
  if d is null then
    raise exception 'ord_stay_nights_chk 不見了 —— 不要 commit';
  end if;
  if position('other_biz' in d) = 0 then
    raise exception '新定義裡沒有 other_biz：%', d;
  end if;
  -- ★ 舊的兩個不可以弄丟
  if position('oneoff' in d) = 0 or position('airbnb_cancelled' in d) = 0 then
    raise exception '把舊的例外弄丟了：%', d;
  end if;
end $do$;

-- ── ③ 真的插一筆試試看（子交易，插完就退掉，不留資料）──
/*
 * ★★★ 這一段問的是**行為**，不是定義。
 *   只比對 `pg_get_constraintdef()` 的字串等於「拿我寫的跟我寫的比」——
 *   migration_262 就是那樣自我證明成功的（2026-09-17）。
 * ★★ plpgsql 的 `begin ... exception` 是一個**子交易**：
 *   在裡面 raise 就只退掉這一段，外面的 ① 不受影響。
 *   變數不是交易性的，所以 `ok` 退不掉 —— 那正是我們要帶出來的東西。
 */
do $do$
declare ok boolean := false; m text := '';
begin
  begin
    insert into public.orders (order_key, source, book, guest_name,
                               checkin, checkout, nights, amount, imported_via)
    values ('M288_PROBE_' || clock_timestamp()::text, 'other_biz', 'aipi', '自檢用',
            date '2026-07-31', date '2026-07-31', 0, 1, 'manual');
    ok := true;
    raise exception 'M288_ROLLBACK_PROBE';   -- 把這一筆退掉
  exception when others then
    if sqlerrm = 'M288_ROLLBACK_PROBE' then m := '插得進去（已退掉，沒有留下資料）';
    else ok := false; m := sqlerrm; end if;
  end;
  insert into _m288_probe values (ok, m);
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('288_other_biz_same_day');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★★ 看不到下面這張表 ＝ 整支回滾了，不是「跑成功但沒輸出」。
-- ★★ 每一列問的都是**最終狀態**，跑第二次、第十次答案一模一樣。
-- ══════════════════════════════════════════════════════════
with def as (
  select pg_get_constraintdef(con.oid) as d
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'orders'
     and con.conname = 'ord_stay_nights_chk'
)
select * from (
  select 0 as s, '⓪ ⚠ 母體：orders 總筆數' as 項目,
         (select count(*)::text from public.orders) as 值,
         case when (select count(*) from public.orders) = 0
              then '❌ 一筆都沒有 —— 下面全部不算數'
              else '✅ 有東西可以檢查' end as 判定

  union all
  select 1, '① 約束還在嗎',
         coalesce((select left(d, 120) from def), '（不見了）'),
         case when exists (select 1 from def) then '✅' else '❌ 約束不見了' end

  union all
  select 2, '② 定義裡有 other_biz 了嗎',
         case when (select position('other_biz' in d) from def) > 0 then '有' else '沒有' end,
         case when (select position('other_biz' in d) from def) > 0 then '✅' else '❌' end

  union all
  select 3, '③ 舊的兩個例外還在嗎（oneoff／airbnb_cancelled）',
         case when (select position('oneoff' in d) from def) > 0
               and (select position('airbnb_cancelled' in d) from def) > 0
              then '兩個都在' else '掉了' end,
         case when (select position('oneoff' in d) from def) > 0
               and (select position('airbnb_cancelled' in d) from def) > 0
              then '✅' else '❌ 把舊的例外弄丟了' end

  union all
  -- ★ 這一列問的是行為：真的插一筆 other_biz 同一天的單，插完退掉
  select 4, '④ 實測：other_biz 同一天的收入插得進去嗎',
         coalesce((select msg from _m288_probe limit 1), '（自檢沒跑到）'),
         case when coalesce((select ok from _m288_probe limit 1), false)
              then '✅ 插得進去' else '❌ 還是被擋' end

  union all
  select 5, '⑤ 既有的「同一天 ＋ 0 晚」還在嗎（改之前是 450 筆 oneoff）',
         (select count(*)::text from public.orders
           where checkin is not null and checkin = checkout),
         case when (select count(*) from public.orders
                     where checkin is not null and checkin = checkout) >= 450
              then '✅ 沒有少' else '❌ 變少了 —— 這支不該刪任何資料' end

  union all
  select 6, '⑥ 自檢用的那一筆有沒有留下來（應該 0）',
         (select count(*)::text from public.orders where order_key like 'M288_PROBE_%'),
         case when (select count(*) from public.orders where order_key like 'M288_PROBE_%') = 0
              then '✅ 沒有留下資料' else '❌ 有殘留，要手動刪掉' end

  union all
  select 7, '⑦ 這支跑過了沒（schema_migrations）',
         coalesce((select name from public.schema_migrations
                    where name = '288_other_biz_same_day'), '（沒有紀錄）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '288_other_biz_same_day')
              then '✅' else '⚠ 沒記到（record_migration 不存在？）' end
) x
order by s;
