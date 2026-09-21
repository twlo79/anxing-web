/*
 * migration_286_advance_repay.sql　2026-09-21
 * 代墊攤還：一筆錢還進來，從最舊的一筆開始扣
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 * ★★ 自檢在 commit 後面 —— **看不到那張表 ＝ 整支回滾了**，
 *    不是「跑成功但沒輸出」。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-21】
 *   「兩種付帳模式：1. 逐筆攤還 2. 一筆非整攤還，從最前面一筆扣」
 *   「需要填 還入帳號：安幸的　出帳帳號：愛皮的」
 *   「打勾與還款配不上 就擋住」「金額不能超過總欠款 > 會擋」
 *   「要還到完為止 然後 也要能看出剩餘款」
 *   「結清需要人按」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼不是「加一個欄位」就好】
 *
 * 現在判狀態只有兩個欄位，而且它們被一條 check 綁死：
 *
 *     ap_refund_pair_chk  CHECK ((refunded_on IS NULL) = (refunded_amount IS NULL))
 *
 * 攤還到一半正是「**有金額、還沒結清**」—— 一存就撞這條約束。
 *
 * 而且就算拿掉約束，語意還是撞：`refunded_amount < amount` 目前的意思是
 * **被扣**，前端看到就會自動產生一筆支出把差額記成公司的損失。
 * 攤還到一半的列長得一模一樣 —— 7,350 收了 6,000，那 1,350 會被記成費用，
 * 而事實是愛皮下個月就會還。
 *
 * ★★ 所以這一支做三件事：
 *     ① 把 `refunded_on` 的意思收斂成「**結清日**」—— 有值＝這列結束了
 *     ② `refunded_amount` 變成「**累計已還**」，由還款明細加總維護
 *     ③ 還款本身變成一張單（日期、金額、兩個帳戶），一單配多列
 *
 *   於是四個狀態各有各的形狀：
 *
 *     結清日 null ＋ 已還 null/0          → 待收回
 *     結清日 null ＋ 0 < 已還 < 代墊      → **部分收回**（差額是應收）
 *     結清日 有值 ＋ 已還 >= 代墊         → 已收回
 *     結清日 有值 ＋ 已還 <  代墊         → **已結清（被扣）**（差額記成費用）
 *
 * ★ 「剩餘款」＝ 代墊 − 已還，**不存欄位** —— 算出來的
 *   （README：推導值存成欄位，`bank_transactions.balance` 踩過）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 收滿了自動填結清日，但「認賠」一定要人按】
 *
 * 還滿的那一刻差額是 0，「結清」沒有任何判斷要做 —— 所以 RPC 自己填。
 *
 * 收不回來的零頭**不自動**。系統唯一能用的判準是「拖很久了」，
 * 而「拖很久」跟「不還了」不是同一件事：自動認賠之後對方真的還了，
 * 那筆錢會變成「收回一筆已經認列成費用的代墊」，兩邊都要再改一次。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 新表的 policy 是「照抄」advance_payments 的，不是我重打一份】
 *
 * 還款單該給誰看＝暫付該給誰看，是同一條規則。重打一份的話
 * 那兩份會各自漂走，而且**自檢會永遠回綠**（比的是我寫的跟我寫的，
 * README：migration_262 的帳密權限踩過）。
 *
 * 所以底下用 `pg_get_expr()` 把 `advance_payments` 那幾條 policy 的判斷式
 * **原封不動**套到新表上。套不上去就整支炸掉 —— 那是對的：
 * RLS 開著而沒有 policy ＝ 查詢回成功、0 列，畫面上是一個很正常的
 * 「0 筆 $0」，沒有任何錯誤（README 踩過兩次）。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】`if not exists` / `or replace` / `drop ... if exists`。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════════════════════════════════════════════════════════
-- ① 換掉那條把兩個欄位綁死的 check
-- ══════════════════════════════════════════════════════════

/*
 * ★★★ 舊定義留底（README：約束 drop 掉要把定義寫進 COMMENT）——
 *   一條看門的規則安靜消失，比留著它更糟。
 */
comment on column public.advance_payments.refunded_on is
  '結清日。有值＝這一列結束了,不再追(2026-09-21 起)。'
  '★ 2026-09-21 之前它的意思是「收回日」,而 ap_refund_pair_chk 原本是 '
  'CHECK ((refunded_on IS NULL) = (refunded_amount IS NULL)) —— '
  '那條擋住了「有金額、還沒結清」,也就是攤還到一半(migration_286 換掉)。';

comment on column public.advance_payments.refunded_amount is
  '累計已還。★★ 2026-09-21 起由 advance_repayment_lines 的加總維護'
  '(trg_arl_sync),不要直接寫 —— trg_ap_guard_refunded 會擋。'
  '★ 沒有還款明細的列(押金、保證金)還是由抽屜直接填,那條路沒變。';

alter table public.advance_payments drop constraint if exists ap_refund_pair_chk;
alter table public.advance_payments add constraint ap_refund_pair_chk
  check (refunded_on is null or refunded_amount is not null);

comment on constraint ap_refund_pair_chk on public.advance_payments is
  '結清了就一定要有「已還多少」(全額被扣就是 0)。'
  '★ 反過來不成立:有已還金額而沒有結清日＝**部分收回**,還在攤(migration_286)。';


-- ══════════════════════════════════════════════════════════
-- ② 還款單（一次匯款 ＝ 一張單）
-- ══════════════════════════════════════════════════════════

create table if not exists public.advance_repayments (
  id           uuid primary key default gen_random_uuid(),
  /* 誰還的。★ 一張單只能有一個對象 —— 一次還款是一筆錢進來 */
  counterparty text not null,
  /* 哪一本帳還的（aipi / hongsha）。跟 advance_payments.for_book 同一套值 */
  for_book     text,
  repaid_on    date not null,
  amount       numeric not null,
  /* ★★ 兩個帳戶都要記:錢從對方哪個帳戶出去、進到安幸哪個帳戶 */
  in_account   text not null,
  out_account  text not null,
  note         text,
  created_by   uuid references public.profiles(id) on delete set null,
  /* ★ clock_timestamp() 不是 now() —— now() 是交易開始時間（README） */
  created_at   timestamptz not null default clock_timestamp()
);

comment on table public.advance_repayments is
  '代墊還款單:對方一次還進來的一筆錢(migration_286)。'
  '★ 一張單配好幾列暫付,分配在 advance_repayment_lines。'
  '★★ 每一列還欠多少是**算出來的**(代墊 − 累計已還),不存欄位。';

do $do$ begin
  alter table public.advance_repayments add constraint arp_amount_chk check (amount > 0);
exception when duplicate_object or duplicate_table then null; end $do$;

do $do$ begin
  alter table public.advance_repayments add constraint arp_book_chk
    check (for_book is null or for_book in ('aipi', 'hongsha'));
exception when duplicate_object or duplicate_table then null; end $do$;

do $do$ begin
  /* ★ 同一個帳戶進出＝這筆錢沒有移動過 */
  alter table public.advance_repayments add constraint arp_account_chk
    check (btrim(in_account) <> btrim(out_account));
exception when duplicate_object or duplicate_table then null; end $do$;


-- ══════════════════════════════════════════════════════════
-- ③ 分配明細（一張還款單扣到哪幾列、各扣多少）
-- ══════════════════════════════════════════════════════════

create table if not exists public.advance_repayment_lines (
  id           uuid primary key default gen_random_uuid(),
  repayment_id uuid not null references public.advance_repayments(id) on delete cascade,
  /*
   * ★★★ `on delete restrict`:暫付那一列被刪掉的話，
   *   還款明細會變成指著空氣的錢。要刪先處理還款。
   */
  advance_id   uuid not null references public.advance_payments(id) on delete restrict,
  amount       numeric not null,
  created_at   timestamptz not null default clock_timestamp()
);

comment on table public.advance_repayment_lines is
  '一張還款單扣到哪幾列暫付、各扣多少(migration_286)。'
  '★★ advance_payments.refunded_amount 就是這張表的加總,由 trg_arl_sync 維護。';

do $do$ begin
  alter table public.advance_repayment_lines add constraint arl_amount_chk check (amount > 0);
exception when duplicate_object or duplicate_table then null; end $do$;

/*
 * ★ 同一張單不該扣同一列兩次 —— 扣兩次的話兩筆都合法、總額也對，
 *   但那一列的分配紀錄會變成兩行，對帳時看起來像重複入帳。
 *
 * ★★★ 用 `create unique index if not exists` 而不是 `add constraint ... unique`：
 *   後者跑第二次丟的是 **`duplicate_table`**（它底下建的是一個索引），
 *   不是 `duplicate_object` —— 原本那個 `exception when duplicate_object`
 *   接不到，於是整支在**第二次跑**的時候炸掉。
 *   （2026-09-21 本地跑出來的。第一次的冪等測試沒帶 `ON_ERROR_STOP`，
 *     錯誤沒有中斷、自檢照印，兩次輸出一模一樣 —— 測試本身是瞎的。）
 */
create unique index if not exists arl_once_uniq
  on public.advance_repayment_lines (repayment_id, advance_id);

create index if not exists arl_advance_idx
  on public.advance_repayment_lines (advance_id, created_at);


-- ══════════════════════════════════════════════════════════
-- ④ RLS ＋ policy（★★★ 照抄 advance_payments 的，不重打一份）
-- ══════════════════════════════════════════════════════════

alter table public.advance_repayments      enable row level security;
alter table public.advance_repayment_lines enable row level security;

do $do$
declare
  p   record;
  t   text;
  n   integer := 0;
  v_q text;
  v_c text;
begin
  for p in
    select pol.polname,
           pol.polcmd::text                                   as cmd,
           pg_get_expr(pol.polqual,      pol.polrelid)        as qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid)        as wchk,
           (select string_agg(quote_ident(r.rolname), ', ')
              from pg_roles r where r.oid = any(pol.polroles)) as roles
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = 'advance_payments'
     order by pol.polname
  loop
    n := n + 1;
    foreach t in array array['advance_repayments', 'advance_repayment_lines']
    loop
      execute format('drop policy if exists %I on public.%I', p.polname || '_' || t, t);
      /*
       * ★ 判斷式裡若出現 advance_payments 才有的欄位，這裡會炸 ——
       *   **那是對的**，停下來比「建了一條半對的 policy」好。
       *   炸掉的話把錯誤訊息貼回來，我照那個判斷式改。
       */
      v_q := coalesce(p.qual, 'true');
      v_c := coalesce(p.wchk, p.qual, 'true');
      execute format(
        'create policy %I on public.%I as permissive for %s to %s using (%s)%s',
        p.polname || '_' || t, t,
        case p.cmd when 'r' then 'select' when 'a' then 'insert'
                   when 'w' then 'update' when 'd' then 'delete' else 'all' end,
        coalesce(p.roles, 'public'),
        v_q,
        case when p.cmd in ('a', 'w', '*') then format(' with check (%s)', v_c) else '' end);
    end loop;
  end loop;

  /*
   * ★★★ advance_payments 一條 policy 都沒有的話,上面等於什麼都沒建 ——
   *   而 RLS 已經開了 ＝ 兩張新表**全部擋掉**,查詢回成功、0 列,
   *   畫面上是一個很正常的「0 筆 $0」(README 踩過兩次)。
   *   所以這裡一定要炸。
   */
  if n = 0 then
    raise exception 'advance_payments 上一條 policy 都沒有 —— '
      '照抄不出東西來,而新表的 RLS 已經開了。停下來,把這句貼回對話。';
  end if;
end $do$;

/* ★ insert 時前端不送 created_by,由 RPC 填 auth.uid()。這兩行是給 PostgREST 直讀用的 */
grant select on public.advance_repayments      to authenticated;
grant select on public.advance_repayment_lines to authenticated;


-- ══════════════════════════════════════════════════════════
-- ⑤ 觸發器：refunded_amount ＝ 明細加總（唯一的寫入者）
-- ══════════════════════════════════════════════════════════

/*
 * ★★★ SECURITY DEFINER 是刻意的。
 *   這支維護的是一個**推導值**，不是使用者的動作 —— 權限問題在
 *   「能不能寫進 advance_repayment_lines」那一關就答完了。
 *   用 INVOKER 的話 RLS 會把這個 UPDATE 擋成「成功、0 列」，
 *   於是明細有了而累計已還還是空的，**沒有任何地方會叫**。
 *
 * ★ 一筆明細都沒有時回 **null** 不是 0:
 *   null ＝ 從來沒還過，0 ＝ 還了 0 元（全額被扣）。兩件事。
 */
create or replace function public.arl_sync_refunded()
returns trigger language plpgsql
security definer set search_path = public
as $fn$
declare
  v_id  uuid;
  v_sum numeric;
  v_amt numeric;
  v_on  date;
  v_exp uuid;
begin
  v_id := coalesce(new.advance_id, old.advance_id);

  select sum(l.amount) into v_sum
    from public.advance_repayment_lines l where l.advance_id = v_id;
  select a.amount, a.refunded_on, a.forfeit_expense_id into v_amt, v_on, v_exp
    from public.advance_payments a where a.id = v_id;

  /*
   * ★★★ 還款單被刪掉時要把結清日一起收回去 —— 2026-09-21 本地跑出來的。
   *
   *   刪掉明細 → 累計已還變回 null，而結清日還留著
   *   → 撞 `ap_refund_pair_chk`（結清了就要有金額），
   *     於是「刪一張還款單」會回一句看不懂的約束錯誤。
   *
   *   更糟的是另一半:如果那條 check 不在，那一列會停在
   *   「結清了、但一毛都沒還」—— 剩餘款看起來是 0 而錢其實還在外面。
   *
   * ★ 所以收不滿就不算結清。判準是「現在的加總夠不夠」，
   *   不是「當初是誰填的」—— 後者資料庫分不出來。
   */
  if v_exp is not null and v_on is not null
     and (v_sum is null or v_sum < v_amt) then
    /*
     * ★★ 差額已經記成支出的那一列**不准**這樣被還原:
     *   結清日一收回去，那筆費用就變成沒有來源的孤兒。
     *   要退還款先把那筆支出處理掉。
     */
    raise exception '這一列已經結清而且差額記成支出了（expense %）—— '
      '要退還款請先處理那筆支出', v_exp;
  end if;

  update public.advance_payments a
     set refunded_amount = v_sum,
         refunded_on = case when v_sum is null or v_sum < a.amount
                            then null else a.refunded_on end
   where a.id = v_id;

  return coalesce(new, old);
end $fn$;

drop trigger if exists trg_arl_sync on public.advance_repayment_lines;
create trigger trg_arl_sync
  after insert or update or delete on public.advance_repayment_lines
  for each row execute function public.arl_sync_refunded();


-- ══════════════════════════════════════════════════════════
-- ⑥ 觸發器：有明細的列，不准手改 refunded_amount
-- ══════════════════════════════════════════════════════════

/*
 * ★★★ 同一份資料只能有一個寫的人（README：`deposits.amount` 與 `lines`）。
 *   抽屜那條路本來可以自由填「收回金額」—— 對押金是對的，
 *   對有還款明細的代墊就是第二個寫入者，而兩邊不一致時**不報錯、總額正常、
 *   只有畫面上的數字是舊的**。
 *
 * ★ 這支**不用**任何旗標去放行 ⑤ 的 UPDATE：⑤ 寫進去的值就等於加總，
 *   所以它自己會通過。多一個旗標就多一條會漏掉的路。
 */
create or replace function public.ap_guard_refunded()
returns trigger language plpgsql
security definer set search_path = public
as $fn$
declare v_sum numeric;
begin
  select sum(l.amount) into v_sum
    from public.advance_repayment_lines l where l.advance_id = new.id;
  if v_sum is null then return new; end if;           -- 沒有明細（押金那條路）
  if new.refunded_amount is distinct from v_sum then
    raise exception '「%」有還款明細,累計已還是算出來的(%)不能直接改 —— '
      '要改金額請改那張還款單', coalesce(nullif(new.usage, ''), new.id::text), v_sum;
  end if;
  return new;
end $fn$;

drop trigger if exists trg_ap_guard_refunded on public.advance_payments;
create trigger trg_ap_guard_refunded
  before update of refunded_amount on public.advance_payments
  for each row execute function public.ap_guard_refunded();


-- ══════════════════════════════════════════════════════════
-- ⑦ RPC：一筆還款，一個交易做完
-- ══════════════════════════════════════════════════════════

/*
 * ★★★ 為什麼是 RPC 不是前端跑迴圈：PostgREST **每一個請求各自一個交易**
 *   （README：migration_228 的遞延就是這樣爆的）。8 列分 8 次寫的話，
 *   斷網會停在第 5 列 —— 而那時還款單說收了 13,209、明細只有 5 列，
 *   **每一列自己都合法**。
 *
 * ★★ SECURITY INVOKER —— RLS 照常生效。被擋掉的列不會報錯、只是沒寫進去，
 *   所以最後比「分配總額 vs 還款金額」，對不上就整個回滾。
 */
create or replace function public.repay_advances(
  p_ids    uuid[],
  p_on     date,
  p_pay    numeric,
  p_in     text,
  p_out    text,
  p_picked boolean default false,
  p_note   text default null
) returns uuid
language plpgsql
as $fn$
declare
  v_ids   uuid[];
  v_asked integer;
  v_bad   text;
  v_owed  numeric;
  v_party text;
  v_book  text;
  v_rep   uuid;
  v_left  numeric;
  v_cut   numeric;
  v_sum   numeric;
  r       record;
begin
  /* ★ 先去重:同一個 id 送兩次的話欠款會被算兩遍，而那個數字會通過檢查 */
  v_ids := array(select distinct u from unnest(coalesce(p_ids, '{}'::uuid[])) u where u is not null);
  v_asked := coalesce(array_length(v_ids, 1), 0);
  if v_asked = 0 then raise exception '沒有選任何一列'; end if;

  if p_on is null then raise exception '要填還款日'; end if;
  if p_pay is null then raise exception '要填還款金額'; end if;
  if p_pay <= 0 then raise exception '還款金額要大於 0'; end if;
  if round(p_pay, 2) <> p_pay then raise exception '還款金額最多到小數點後兩位'; end if;
  if coalesce(btrim(p_in), '') = '' then raise exception '要選還入哪個帳戶（安幸的）'; end if;
  if coalesce(btrim(p_out), '') = '' then raise exception '要選從哪個帳戶出去（對方的）'; end if;
  if btrim(p_in) = btrim(p_out) then
    raise exception '還入與出帳是同一個帳戶 —— 那樣這筆錢沒有移動過';
  end if;

  -- ① 只收代墊（押金／保證金被扣時要選會計科目，這條路問不了）
  select string_agg(coalesce(nullif(a.usage, ''), a.id::text)
                    || '（' || coalesce(a.category, '沒填') || '）', '、' order by a.paid_on, a.id)
    into v_bad from public.advance_payments a
   where a.id = any(v_ids) and coalesce(a.category, '') <> '代墊';
  if v_bad is not null then
    raise exception '攤還只處理代墊，這幾列不是：%', v_bad;
  end if;

  -- ② 必須「還收得回來」：出款了、沒結清、而且還欠錢
  select string_agg(coalesce(nullif(a.usage, ''), a.id::text), '、' order by a.paid_on, a.id)
    into v_bad from public.advance_payments a
   where a.id = any(v_ids)
     and (a.paid_on is null or a.refunded_on is not null
          or coalesce(a.refunded_amount, 0) >= a.amount);
  if v_bad is not null then
    /*
     * ★★★ 這裡**不會**自動跳過那幾列。
     *   跳過的話會變成「選了 8 列，只扣了 3 列」而畫面說成功 ——
     *   使用者不會發現，因為總額是對的。
     * ★ 正常情況下前端只會送還收得回來的列（`allocate()` 已經濾過）。
     *   會撞到這裡通常是**別人剛剛收過了**，重新整理就對了。
     */
    raise exception '這幾列收不了（還沒出款、已結清、或已經收滿）：% —— '
      '多半是別人剛剛收過了,重新整理頁面再試一次', v_bad;
  end if;

  -- ③ 一次還款是一筆錢進來 → 只能是同一個對象
  if (select count(distinct coalesce(a.counterparty, ''))
        from public.advance_payments a where a.id = any(v_ids)) > 1 then
    select string_agg(distinct coalesce(a.counterparty, '（沒填）'), '、')
      into v_party from public.advance_payments a where a.id = any(v_ids);
    raise exception '一次只能收同一個對象，選到了：%', v_party;
  end if;

  -- ④ 還款日不能早於出款日
  select string_agg(coalesce(nullif(a.usage, ''), a.id::text)
                    || '（出款 ' || a.paid_on::text || '）', '、' order by a.paid_on, a.id)
    into v_bad from public.advance_payments a
   where a.id = any(v_ids) and p_on < a.paid_on;
  if v_bad is not null then
    raise exception '還款日 % 早於出款日：%', p_on::text, v_bad;
  end if;

  -- ⑤ ★★★ 金額要跟範圍對得起來（2026-09-21 使用者指定）
  select coalesce(sum(a.amount - coalesce(a.refunded_amount, 0)), 0)
    into v_owed from public.advance_payments a where a.id = any(v_ids);

  if p_picked then
    if p_pay <> v_owed then
      raise exception '還款 % 跟勾起來這 % 列的欠款 % 對不上（差 %）—— '
        '逐筆還要剛好還完；想留零頭的話取消勾選改用金額還',
        p_pay, v_asked, v_owed, abs(p_pay - v_owed);
    end if;
  elsif p_pay > v_owed then
    raise exception '還款 % 比總欠款 % 多 % —— 多出來的不是代墊的收回，要另外記一筆收入',
      p_pay, v_owed, p_pay - v_owed;
  end if;

  select coalesce(max(a.counterparty), ''), max(a.for_book)
    into v_party, v_book
    from public.advance_payments a where a.id = any(v_ids);

  insert into public.advance_repayments
    (counterparty, for_book, repaid_on, amount, in_account, out_account, note, created_by)
  values
    (v_party, v_book, p_on, p_pay, btrim(p_in), btrim(p_out),
     nullif(btrim(p_note), ''), auth.uid())
  returning id into v_rep;

  /*
   * ⑥ ★★★ 從最舊的一筆開始扣。排序鍵一路排到 id ——
   *   清單本來只有 paid_on 一個鍵，同一天那幾列的順序是 Postgres 隨便給的，
   *   **每次查都可能不一樣**。那樣「從最前面一筆扣」指著一個會變的東西。
   *   這一組鍵跟前端 `repayOrder()` 是同一組。
   */
  v_left := p_pay;
  for r in
    select a.id as aid, (a.amount - coalesce(a.refunded_amount, 0)) as owe
      from public.advance_payments a
     where a.id = any(v_ids)
     order by a.paid_on, a.created_at, a.id
  loop
    exit when v_left <= 0;
    v_cut := least(v_left, r.owe);
    if v_cut > 0 then
      insert into public.advance_repayment_lines (repayment_id, advance_id, amount)
        values (v_rep, r.aid, v_cut);
      v_left := round(v_left - v_cut, 2);
    end if;
  end loop;

  /*
   * ⑦ ★★★ RLS 擋下來的 INSERT 會**回成功而且影響 0 列**（README 的坑）。
   *   不比這個數字的話，沒權限的人按下去會看到「已收回」而一列都沒寫進去。
   */
  select coalesce(sum(l.amount), 0) into v_sum
    from public.advance_repayment_lines l where l.repayment_id = v_rep;
  if v_sum <> p_pay then
    raise exception '分配出去的 % 跟還款金額 % 對不上 —— '
      '可能是權限不足（暫付限會計以上），或那幾列剛剛被別人改過', v_sum, p_pay;
  end if;

  /*
   * ⑧ 收滿的自動填結清日。
   * ★★ 這**不是**替人認賠 —— 收滿的那一刻差額是 0，沒有判斷要做。
   *   收不回來的零頭要人按（那一列的抽屜），因為系統分不出
   *   「下週會還」跟「不還了」。
   */
  update public.advance_payments a
     set refunded_on = p_on
   where a.id = any(v_ids) and a.refunded_on is null
     and coalesce(a.refunded_amount, 0) >= a.amount;

  return v_rep;
end $fn$;

comment on function public.repay_advances(uuid[], date, numeric, text, text, boolean, text) is
  '代墊攤還(migration_286)。一個交易寫完還款單與全部分配明細。'
  '★ 從最舊的一筆開始扣(paid_on, created_at, id),跟前端 repayOrder() 同一組鍵。'
  '★★ p_picked=true(有勾選)時金額必須剛好等於那幾列的欠款;false 時不得超過總欠款。'
  '★★★ SECURITY INVOKER —— RLS 照常生效,被擋掉的列靠「分配總額 vs 還款金額」抓出來。';

grant execute on function
  public.repay_advances(uuid[], date, numeric, text, text, boolean, text) to authenticated;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('286_advance_repay');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 ＝ 整支回滾了。
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1 as ord, '① 兩張新表在不在' as "檢查",
         (select string_agg(c.relname::text, '、' order by c.relname)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind::text = 'r'   -- ★ 濾 relkind:索引也會被掃進來
             and c.relname in ('advance_repayments', 'advance_repayment_lines')) as "結果",
         case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relkind::text = 'r'
                       and c.relname in ('advance_repayments', 'advance_repayment_lines')) = 2
              then '✅ 兩張都在' else '❌ 少了' end as "判定"

  union all
  select 2, '★★★ ② 新表的 RLS 開了而且有 policy',
         (select string_agg(c.relname::text || '：'
                   || case when c.relrowsecurity then 'RLS✓' else 'RLS✗' end
                   || ' policy ' || (select count(*) from pg_policy p where p.polrelid = c.oid)::text,
                 '　' order by c.relname)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind::text = 'r'
             and c.relname in ('advance_repayments', 'advance_repayment_lines')),
         case when not exists (
                select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind::text = 'r'
                   and c.relname in ('advance_repayments', 'advance_repayment_lines')
                   and (not c.relrowsecurity
                        or (select count(*) from pg_policy p where p.polrelid = c.oid) = 0))
              then '✅ 都開了而且都有 policy'
              else '❌ RLS 開著而沒有 policy ＝ 查詢回成功、0 列,畫面上是很正常的「0 筆 $0」' end

  union all
  select 3, '★★★ ③ 新表的 policy 條數跟 advance_payments 一樣嗎',
         '暫付 ' || (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
                      join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relname = 'advance_payments')::text
         || ' 條　→　還款單 ' || (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
                      join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relname = 'advance_repayments')::text
         || ' 條　明細 ' || (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
                      join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relname = 'advance_repayment_lines')::text
         || ' 條',
         case when (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
                      join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relname = 'advance_payments')
                 = (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
                      join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relname = 'advance_repayments')
              then '✅ 照抄成功（條數一樣）' else '❌ 條數對不上' end

  union all
  select 4, '★★★ ④ 那條綁死兩個欄位的 check 換掉了嗎',
         coalesce((select pg_get_constraintdef(con.oid) from pg_constraint con
                     join pg_class cl on cl.oid = con.conrelid
                     join pg_namespace n on n.oid = cl.relnamespace
                    where n.nspname = 'public' and cl.relname = 'advance_payments'
                      and con.conname = 'ap_refund_pair_chk'), '（找不到）'),
         case when exists (select 1 from pg_constraint con
                             join pg_class cl on cl.oid = con.conrelid
                            where cl.relname = 'advance_payments'
                              and con.conname = 'ap_refund_pair_chk'
                              and pg_get_constraintdef(con.oid) not like '%=%(%refunded_amount IS NULL%')
              then '✅ 換成「結清了才要有金額」—— 部分收回存得進去了'
              else '❌ 還是舊的,攤還到一半一存就撞' end

  union all
  select 5, '★★ ⑤ 三支函式與兩支觸發器在不在',
         coalesce((select string_agg(x.nm, '、' order by x.nm) from (
           select p.proname::text as nm from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind in ('f', 'p')
              and p.proname::text in ('repay_advances', 'arl_sync_refunded', 'ap_guard_refunded')
           union all
           select t.tgname::text from pg_trigger t
            where not t.tgisinternal and t.tgname in ('trg_arl_sync', 'trg_ap_guard_refunded')
         ) x), '（一個都沒有）'),
         case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.prokind in ('f', 'p')
                       and p.proname::text in ('repay_advances', 'arl_sync_refunded', 'ap_guard_refunded')) = 3
               and (select count(*) from pg_trigger t
                     where not t.tgisinternal
                       and t.tgname in ('trg_arl_sync', 'trg_ap_guard_refunded')) = 2
              then '✅ 五個都在' else '❌ 少了' end

  union all
  select 6, '★★ ⑥ repay_advances 是 invoker 嗎',
         coalesce((select case when p.prosecdef then 'definer' else 'invoker' end
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname::text = 'repay_advances'
                      and p.prokind in ('f', 'p')), '（找不到）'),
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.proname::text = 'repay_advances'
                              and p.prokind in ('f', 'p') and not p.prosecdef)
              then '✅ invoker —— RLS 照常生效'
              else '❌ definer 的話任何登入者都收得了別人的暫付' end

  union all
  /*
   * ★★★ 母體要判定,不能只印數字。
   *   一筆代墊都沒有的話下面那句「舊資料沒有被動到」是自動成立的,
   *   而六個綠勾會讓人以為做完了（README：migration_210 踩過）。
   */
  select 7, '★★★ ⑦ 舊資料有沒有被動到',
         '代墊 ' || (select count(*) from public.advance_payments where category = '代墊')::text
         || ' 列　其中待收回 '
         || (select count(*) from public.advance_payments
              where category = '代墊' and paid_on is not null and refunded_on is null)::text
         || ' 列　還款單 '
         || (select count(*) from public.advance_repayments)::text || ' 張',
         case when (select count(*) from public.advance_payments where category = '代墊') = 0
              then '⚠ 一筆代墊都沒有 —— 這一列與下面 ⑧ 都不算數'
              when (select count(*) from public.advance_repayments) = 0
              then '✅ 這支只改結構,一張還款單都還沒有（對的,那是畫面的事）'
              else 'ℹ 已經有還款單了' end

  union all
  select 8, '★★★ ⑧ 有沒有哪一列現在是「部分收回」',
         (select count(*)::text || ' 列'
            from public.advance_payments
           where refunded_on is null and coalesce(refunded_amount, 0) > 0),
         case when (select count(*) from public.advance_payments
                     where refunded_on is null and coalesce(refunded_amount, 0) > 0) = 0
              then '✅ 0 列 —— 這支還沒產生任何部分收回（對的,還款要從畫面按）'
              else '⚠ 已經有部分收回了 —— 這支跑之前不該存在,把這一列貼回對話' end

  union all
  select 9, '⑨ 這支記到 schema_migrations 了嗎',
         coalesce((select s.name from public.schema_migrations s
                    where s.name = '286_advance_repay'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations s
                            where s.name = '286_advance_repay')
              then '✅ 記到了' else '❌ 沒記到 —— 以後「跑了沒」要靠考古' end

) v(ord, "檢查", "結果", "判定")
order by v.ord;
