/*
 * migration_247_contract_purpose.sql　2026-09-14
 * 安幸辦公室（③④）：把「這筆收入屬安幸辦公室」搬到**契約層級**
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼不是改 gen_contract_orders】
 *
 * 235 給 `orders` 加了 `purpose_type`，①② 讓短租那頁可以勾。
 * 契約這邊本來的計畫是「改產生器，讓它把契約的標記帶進月租單」。
 *
 * 看過線上的定義之後**不這樣做**，理由有三個：
 *
 *   ① `gen_contract_orders` 有 **四個**寫入點（insert、兩個 update 分支、
 *      還有 conflict 那支），四個地方都要記得加同一欄。
 *      這正是 CLAUDE.md 那條「同一條規則在三個地方各寫一次」。
 *
 *   ② 真正決定營收報表數字的**不是訂單，是認列**
 *      （`revenues/page.tsx` 讀的是 `revenue_recognitions`）。
 *      而長租的認列是 `gen_contract_recognitions` 產的，
 *      它**整支從頭到尾沒有碰過 purpose_type**。
 *      只改產生器的話：訂單上看得到標記、報表數字一毛不動 ——
 *      而那不會報錯。
 *
 *   ③ 沒有房號的契約（辦公室登記、公司登記）**根本不產訂單**
 *      —— `gen_contract_orders` 第一行就 return。
 *      （它的註解說那些「由前端契約頁產生」，但前端從頭到尾
 *        沒有任何一支 insert 在寫月租單，2026-09-14 查過。
 *        那批契約只有認列、沒有訂單。）
 *      靠訂單傳遞標記的話，這批永遠傳不到。
 *
 * ★ 所以改成**四支小觸發器**，每條規則只寫一次：
 *
 *     契約存檔前　　→ 辦公室登記／公司登記一律 office（勾不勾都一樣）
 *     契約的用途改了→ 往下推到底下所有的訂單與認列
 *     訂單新增/修改→ 帶 contract_id 的，用途一律照契約
 *     認列新增/修改→ 沒填用途的，從契約（其次訂單）補上
 *
 *   產生器一行都不用動，而不管它以後怎麼改寫、多幾個寫入點，
 *   標記都會自己跟上。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 這支會讓營收報表的數字變 —— 而那是在修一個舊 bug】
 *
 * 235 的第 ④ 步把「沒有對應訂單的認列」一律補成 `'estate'`。
 * 那批裡面包含**辦公室登記與公司登記的契約認列**（它們沒有訂單）。
 *
 * 而前端 `inEstateBlock` 是：
 *     purpose_type 有值 → 只認 'estate'
 *     purpose_type 沒值 → 退回舊的 `!isOffice && !isCompany`
 *
 * 補成 'estate' 之後它們從「退回舊列舉（排除）」變成「'estate'（納入）」
 * —— 辦公室與公司登記的收入被算進**依物業**那一段了。
 *
 * 這支的第 ③ 步把它們改回 'office'，數字就回到 235 之前。
 * 自檢第 ⑥ 條把「哪些認列被改了」逐類列出來給你核對。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════════════════════════════════════════════════════════
-- ① 契約加用途
-- ══════════════════════════════════════════════════════════
alter table public.contracts
  add column if not exists purpose_type text not null default 'estate';

-- 跟 orders_purpose_chk 同一組值 —— 兩邊不一樣的話，
-- 契約存得進去、往下推到訂單時才炸，而錯誤訊息會指向訂單
alter table public.contracts drop constraint if exists contracts_purpose_chk;
alter table public.contracts add constraint contracts_purpose_chk
  check (purpose_type in ('estate', 'office', 'other_biz'));

comment on column public.contracts.purpose_type is
  '這張契約的收入算誰的。estate＝物業（正隆…）／office＝安幸辦公室／other_biz＝其他事業。'
  '★ 房源與物業**照舊填**（正隆 B01）—— 這一欄只換營收報表的歸屬，'
  '不會讓一間房同時屬於兩個物業。契約是唯一真相，訂單與認列都跟著它走。';

-- ══════════════════════════════════════════════════════════
-- ② 改之前先拍一張認列的快照
--
-- ★★ 用**一般表**，不是 `on commit drop` 的暫存表 ——
--    244 就是死在這：暫存表在 commit 當下消失，
--    而自檢是在 commit **之後**才跑，於是拿不到快照。
-- ══════════════════════════════════════════════════════════
drop table if exists public._m247_before;
create table public._m247_before as
select r.id, r.contract_id, r.order_id, r.source,
       r.purpose_type, r.month_amount, r.ym
  from public.revenue_recognitions r;

comment on table public._m247_before is
  'migration_247 改動前的認列快照。自檢核對完就可以 drop table public._m247_before;';

drop table if exists public._m247_test;
create table public._m247_test (ord int, name text, detail text, verdict text);

-- ══════════════════════════════════════════════════════════
-- ③ 辦公室登記與公司登記**一定**是 office
--
-- ★ 這兩種是**安幸自己的生意**，不是幫股東收的房租。
--   TYPE_LABEL 就寫在契約頁第 71 行：office＝辦公室、company＝公司登記。
--
-- ★★ 做成觸發器而不是只回填一次 —— 只回填的話，
--    之後任何一次存檔（前端少送一欄、SQL Editor 手改）就破功，
--    而破功的症狀是「辦公室的收入混進正隆的營收」，沒有任何錯誤訊息。
--    前端 lib/purpose.ts 的 contractPurpose() 是同一條規則的畫面版。
-- ══════════════════════════════════════════════════════════
create or replace function public.contract_purpose_normalize()
returns trigger
language plpgsql
as $fn$
begin
  if new.type in ('office', 'company') then new.purpose_type := 'office'; end if;
  if new.purpose_type is null then new.purpose_type := 'estate'; end if;
  return new;
end $fn$;

comment on function public.contract_purpose_normalize() is
  '辦公室登記與公司登記的契約一律 purpose_type = office（migration_247）。'
  '★ 它們是安幸自己的生意，不是幫股東收的房租 —— 勾不勾都一樣。';

drop trigger if exists trg_contract_purpose_normalize on public.contracts;
create trigger trg_contract_purpose_normalize
  before insert or update on public.contracts
  for each row execute function public.contract_purpose_normalize();

-- 既有資料照同一條規則補齊
update public.contracts
   set purpose_type = 'office'
 where type in ('office', 'company')
   and purpose_type is distinct from 'office';

-- ══════════════════════════════════════════════════════════
-- ④ 訂單：帶 contract_id 的，用途一律照契約
--
-- ★★ security definer —— 房務角色看不到 contracts，
--    走 RLS 的話這裡 select 會撈到 null，然後**安靜地不做事**。
-- ══════════════════════════════════════════════════════════
create or replace function public.order_purpose_from_contract()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v text;
begin
  if new.contract_id is null then return new; end if;
  select c.purpose_type into v from public.contracts c where c.id = new.contract_id;
  -- 契約被刪了（或還沒寫進去）就別動 —— 猜一個值比留原值糟
  if v is not null then new.purpose_type := v; end if;
  return new;
end $fn$;

comment on function public.order_purpose_from_contract() is
  '契約產生的月租單、契約加費、契約折讓，用途一律以契約為準（migration_247）。'
  '★ 所以短租那頁的「屬安幸辦公室」勾選框對這些單是唯讀的 —— 要改請改契約。';

/*
 * ★ 觸發器名字刻意排在 `trg_orders_period_lock` **前面**
 *   （'trg_order_' < 'trg_orders_'，底線的碼位比 s 小）。
 *   關帳守門員對 `imported_via = 'contract'` 一律放行，
 *   所以月租單這條路上兩支不會打架。
 */
drop trigger if exists trg_order_purpose_from_contract on public.orders;
create trigger trg_order_purpose_from_contract
  before insert or update on public.orders
  for each row execute function public.order_purpose_from_contract();

-- ══════════════════════════════════════════════════════════
-- ⑤ 認列：沒填用途的，從契約（其次訂單）補上
--
-- ★★★ 這一支才是真正決定報表數字的那個 ——
--    `gen_contract_recognitions` 從頭到尾沒寫過 purpose_type，
--    它 delete + 重新 insert，新的那批全是 null。
--    補的責任放在這裡，那支產生器怎麼改寫都不用回來加欄位。
-- ══════════════════════════════════════════════════════════
create or replace function public.recog_purpose_fill()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v text;
begin
  -- 已經有值就不動。gen_recognitions（短租、oneoff）自己會帶 o.purpose_type，
  -- 蓋掉的話短租那頁的勾選就失效了
  if new.purpose_type is not null then return new; end if;

  if new.contract_id is not null then
    select c.purpose_type into v from public.contracts c where c.id = new.contract_id;
  end if;
  if v is null and new.order_id is not null then
    select o.purpose_type into v from public.orders o where o.id = new.order_id;
  end if;

  -- 兩邊都查不到才預設 estate。**不留 null** ——
  -- 前端 `inEstateBlock` 對 null 會退回舊的 source 列舉，
  -- 於是同一份報表裡有兩套判斷標準在跑
  new.purpose_type := coalesce(v, 'estate');
  return new;
end $fn$;

comment on function public.recog_purpose_fill() is
  '認列沒填用途就從契約（其次訂單）補（migration_247）。'
  'gen_contract_recognitions 不寫這一欄，補的責任集中在這裡。';

drop trigger if exists trg_recog_purpose_fill on public.revenue_recognitions;
create trigger trg_recog_purpose_fill
  before insert or update on public.revenue_recognitions
  for each row execute function public.recog_purpose_fill();

-- ══════════════════════════════════════════════════════════
-- ⑥ 契約改了就往下推
-- ══════════════════════════════════════════════════════════
create or replace function public.contract_purpose_propagate()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- `update of purpose_type` 只看有沒有寫進 SET，值一樣照樣會叫
  if new.purpose_type is not distinct from old.purpose_type then return null; end if;

  update public.orders
     set purpose_type = new.purpose_type
   where contract_id = new.id
     and purpose_type is distinct from new.purpose_type;

  update public.revenue_recognitions
     set purpose_type = new.purpose_type
   where contract_id = new.id
     and purpose_type is distinct from new.purpose_type;

  return null;
end $fn$;

comment on function public.contract_purpose_propagate() is
  '契約的用途改了，既有的訂單與認列一起改（migration_247）。'
  '★ 不改的話畫面上勾了、報表要等到下次重算契約才跟上 —— 而使用者不會知道要等。';

drop trigger if exists trg_contract_purpose_propagate on public.contracts;
create trigger trg_contract_purpose_propagate
  after update of purpose_type on public.contracts
  for each row execute function public.contract_purpose_propagate();

-- ══════════════════════════════════════════════════════════
-- ⑦ 回填既有資料
-- ══════════════════════════════════════════════════════════
update public.orders o
   set purpose_type = c.purpose_type
  from public.contracts c
 where c.id = o.contract_id
   and o.purpose_type is distinct from c.purpose_type;

update public.revenue_recognitions r
   set purpose_type = c.purpose_type
  from public.contracts c
 where c.id = r.contract_id
   and r.purpose_type is distinct from c.purpose_type;

-- ══════════════════════════════════════════════════════════
-- ⑧ 觸發器**實測** —— 真的去叫它，然後整段退掉
--
-- ★★★ README 第 3.5 條：自檢要「叫那支東西」，
--    光查 pg_trigger 裝上了沒只證明它存在，不證明它會動。
--
-- ★ 用 plpgsql 的 exception 區塊當子交易：裡面故意 raise，
--   資料改動全部退掉，而 plpgsql 的變數**不隨交易回滾**，
--   所以判定結果留得下來。
-- ══════════════════════════════════════════════════════════
do $do$
declare
  v_ct    public.contracts.id%type;
  v_ord   public.orders.id%type;
  v_rec   public.revenue_recognitions.id%type;
  v_cur   text; v_other text; v_got text; v_err text := '';
  ok_ord  boolean := false;
  ok_rec  boolean := false;
  ok_prop boolean := false;
  n_bad   int;
begin
  /*
   * ★ 一定要挑 `imported_via = 'contract'` 的月租單。
   *   關帳守門員對月租單一律放行，對其他單在鎖住的月份會**不寫也不報錯**
   *   —— 挑到那種的話值沒變，而自檢會把「沒動」誤判成「觸發器扳回來了」。
   */
  select c.id into v_ct
    from public.contracts c
   where exists (select 1 from public.orders o
                  where o.contract_id = c.id and o.imported_via = 'contract')
     and exists (select 1 from public.revenue_recognitions r where r.contract_id = c.id)
     -- ★ 辦公室登記／公司登記不能拿來測翻面 —— 第 ③ 步的觸發器會把它扳回 office，
     --   那是對的行為，但會讓第 (c) 項誤判成 ❌
     and coalesce(c.type, 'longterm') not in ('office', 'company')
   limit 1;

  if v_ct is null then
    insert into public._m247_test values
      (9, '⑨ 觸發器實測', '找不到可以拿來翻面的契約，測不了', '⚠ 沒測到');
    return;
  end if;

  select c.purpose_type into v_cur from public.contracts c where c.id = v_ct;
  v_other := case when v_cur = 'office' then 'estate' else 'office' end;
  select o.id into v_ord from public.orders o
   where o.contract_id = v_ct and o.imported_via = 'contract' limit 1;
  select r.id into v_rec from public.revenue_recognitions r where r.contract_id = v_ct limit 1;

  begin
    -- (a) 訂單：故意寫一個錯的值，看觸發器有沒有扳回來
    update public.orders set purpose_type = v_other where id = v_ord;
    select o.purpose_type into v_got from public.orders o where o.id = v_ord;
    ok_ord := (v_got = v_cur);

    -- (b) 認列：清成 null，看有沒有從契約補回來
    update public.revenue_recognitions set purpose_type = null where id = v_rec;
    select r.purpose_type into v_got from public.revenue_recognitions r where r.id = v_rec;
    ok_rec := (v_got = v_cur);

    -- (c) 契約翻面，訂單與認列跟不跟
    update public.contracts set purpose_type = v_other where id = v_ct;
    select count(*) into n_bad from (
      select o.purpose_type as pt from public.orders o where o.contract_id = v_ct
      union all
      select r.purpose_type from public.revenue_recognitions r where r.contract_id = v_ct
    ) z where z.pt is distinct from v_other;
    ok_prop := (n_bad = 0);

    raise exception 'M247_ROLLBACK';
  exception when others then
    -- ★ 自己丟的那顆吞掉（它的任務就是把上面的改動退乾淨）；
    --   別人丟的記下來 —— 直接 raise 會讓整支 migration 為了「測試」而失敗
    if sqlerrm <> 'M247_ROLLBACK' then v_err := sqlerrm; end if;
  end;

  insert into public._m247_test values
    (9, '⑨ 觸發器實測（改完已退掉）',
     '訂單被扳回：' || ok_ord || '　認列被補上：' || ok_rec
       || '　契約翻面跟上：' || ok_prop
       || case when v_err <> '' then '　錯誤：' || v_err else '' end,
     case when ok_ord and ok_rec and ok_prop then '✅ 三支都會動'
          else '❌ 有一支沒動' end);
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('247_contract_purpose');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自　檢　★ 每一列都要有「判定」，不要只給參考值
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① contracts.purpose_type 與約束',
         coalesce((select string_agg(c.purpose_type || '×' || c.n::text, '　' order by c.purpose_type)
                     from (select purpose_type, count(*) n from public.contracts
                            group by purpose_type) c), '（沒有契約）')
         || '　｜約束：'
         || coalesce((select conname from pg_constraint
                       where conrelid = 'public.contracts'::regclass
                         and conname = 'contracts_purpose_chk'), '（沒裝上）'),
         case when exists (select 1 from pg_constraint
                            where conrelid = 'public.contracts'::regclass
                              and conname = 'contracts_purpose_chk')
               and not exists (select 1 from public.contracts where purpose_type is null)
              then '✅ 欄位與約束都在' else '❌' end

  union all
  select 2, '② 四支觸發器都裝上了',
         coalesce((select string_agg(t.tgname, '　' order by t.tgname)
                     from pg_trigger t
                    where not t.tgisinternal
                      and t.tgname in ('trg_order_purpose_from_contract',
                                       'trg_recog_purpose_fill',
                                       'trg_contract_purpose_propagate',
                                       'trg_contract_purpose_normalize')), '（一支都沒有）'),
         case when (select count(*) from pg_trigger t
                     where not t.tgisinternal
                       and t.tgname in ('trg_order_purpose_from_contract',
                                        'trg_recog_purpose_fill',
                                        'trg_contract_purpose_propagate',
                                        'trg_contract_purpose_normalize')) = 4
              then '✅ 四支都在' else '❌ 少了' end

  union all
  select 3, '③ 辦公室登記／公司登記的契約一律 office',
         '不是 office 的有 ' || (select count(*) from public.contracts
                                  where type in ('office', 'company')
                                    and purpose_type is distinct from 'office')::text
         || ' 張　／　這兩類共 '
         || (select count(*) from public.contracts where type in ('office', 'company'))::text || ' 張',
         case when (select count(*) from public.contracts
                     where type in ('office', 'company')
                       and purpose_type is distinct from 'office') = 0
              then '✅ 全部是 office' else '❌ 有漏的' end

  union all
  select 4, '④ 每一張掛契約的訂單，用途都跟契約一致',
         '不一致 ' || (select count(*) from public.orders o
                        join public.contracts c on c.id = o.contract_id
                       where o.purpose_type is distinct from c.purpose_type)::text
         || ' 張　／　掛契約的共 '
         || (select count(*) from public.orders where contract_id is not null)::text || ' 張',
         case when (select count(*) from public.orders o
                     join public.contracts c on c.id = o.contract_id
                    where o.purpose_type is distinct from c.purpose_type) = 0
              then '✅ 全對上' else '❌ 有對不上的' end

  union all
  select 5, '⑤ 每一列掛契約的認列，用途都跟契約一致',
         '不一致 ' || (select count(*) from public.revenue_recognitions r
                        join public.contracts c on c.id = r.contract_id
                       where r.purpose_type is distinct from c.purpose_type)::text
         || ' 列　／　掛契約的共 '
         || (select count(*) from public.revenue_recognitions where contract_id is not null)::text || ' 列',
         case when (select count(*) from public.revenue_recognitions r
                     join public.contracts c on c.id = r.contract_id
                    where r.purpose_type is distinct from c.purpose_type) = 0
              then '✅ 全對上' else '❌ 有對不上的' end

  union all
  /*
   * ★★★ 這一條是「數字為什麼會變」的交代。
   *   被改動的認列**只准是辦公室登記與公司登記的契約** ——
   *   其他任何一列被改到，就是這支動到了不該動的東西。
   */
  select 6, '⑥ 這次改動了哪些認列（金額會從「依物業」離開）',
         coalesce((select string_agg(g.txt, '　')
                     from (select coalesce(ct.type, '（沒有契約）') || '：'
                                  || count(*)::text || ' 列　$'
                                  || to_char(sum(b.month_amount), 'FM9,999,999,999') as txt
                             from public._m247_before b
                             join public.revenue_recognitions r on r.id = b.id
                             left join public.contracts ct on ct.id = b.contract_id
                            where r.purpose_type is distinct from b.purpose_type
                            group by ct.type) g), '（一列都沒改）'),
         case when not exists (
                select 1 from public._m247_before b
                  join public.revenue_recognitions r on r.id = b.id
                  left join public.contracts ct on ct.id = b.contract_id
                 where r.purpose_type is distinct from b.purpose_type
                   and coalesce(ct.type, '') not in ('office', 'company'))
              then '✅ 只動到辦公室／公司登記' else '❌ 動到了長租的認列' end

  union all
  select 7, '⑦ 認列總額一毛沒變（這支只換歸屬，不碰金額）',
         '改前 $' || to_char((select coalesce(sum(month_amount), 0) from public._m247_before), 'FM9,999,999,999')
         || '　改後 $' || to_char((select coalesce(sum(month_amount), 0) from public.revenue_recognitions), 'FM9,999,999,999'),
         case when (select coalesce(sum(month_amount), 0) from public._m247_before)
                 = (select coalesce(sum(month_amount), 0) from public.revenue_recognitions)
              then '✅ 一樣' else '❌ 金額被動到了' end

  union all
  select 8, '⑧ 沒有任何認列的用途是空的',
         '空的 ' || (select count(*) from public.revenue_recognitions where purpose_type is null)::text || ' 列',
         case when (select count(*) from public.revenue_recognitions where purpose_type is null) = 0
              then '✅ 都有值' else '❌ 有 null（前端會退回舊列舉，兩套標準）' end

  union all
  select t.ord, t.name, t.detail, t.verdict from public._m247_test t

  union all
  select 10, '⑩ 收尾',
         '核對完請執行：drop table public._m247_before; drop table public._m247_test;',
         '⚠ 記得清掉這兩張暫存表'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
