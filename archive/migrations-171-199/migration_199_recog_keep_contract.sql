/*
 * migration_199 —— 契約的營收認列：不再被訂單刪掉，而且歸到自己的類別
 * ============================================================
 * 2026-09-01 使用者：「為何沒有南京 認列營收」
 *              → 「我的疑問是 之後filter 怎麼算 還是有 公司登計嗎？」
 *
 * 一支修三件事，因為它們是同一條鏈上的三個結，分開修會互相撞。
 *
 * ============================================================
 * 【A. 南京少 $166,000 —— 刪了不補】
 *
 * `trg_orders_recog`（訂單的 INSERT／UPDATE／DELETE 都會跑）:
 *
 *     if tg_op in ('UPDATE','DELETE') then
 *       delete from revenue_recognitions where order_id = old.id;   ← 刪掉
 *     end if;
 *     if tg_op in ('INSERT','UPDATE') then
 *       perform gen_recognitions(new);                              ← 想補回來
 *     end if;
 *
 * 而 `gen_recognitions` 的第一行:
 *
 *     if o.source = 'longterm' and o.contract_id is not null then return; end if;
 *
 * **契約長租直接走人**（那是對的:它的認列由 `gen_contract_recognitions`
 * 依契約產生，不是依訂單）。
 *
 * ★★★ 於是:刪的那一段照刪，補的那一段什麼都不做。
 *   只要那張月租單被動過一次 —— 收款、改房號、同步、手動編輯 ——
 *   它那個月的認列就永遠消失。
 *
 * ★★ 而 `gen_contract_recognitions` 寫入時**是帶著 order_id 的**
 *   （它會挑重疊最多的訂單掛上去），所以那些列正好是
 *   `delete ... where order_id = old.id` 掃得到的。
 *
 * 實測（南京，5 張契約）:
 *
 *     南京6    24 張月租單 → 24 筆認列   ← 訂單從沒被動過
 *     南京10-1 12 張        → 10 筆      ← 缺 202607、202608
 *     南京10-3 24 張        → 15 筆
 *     南京5    12 張        →  4 筆
 *     南京10-2 12 張        →  1 筆
 *
 * ★ 症狀是**營收表的數字小於實際**，而畫面上沒有任何提示 ——
 *   契約還在、月租單還在、收租狀態也正常，只有認列不見了。
 *
 * ============================================================
 * 【B. 「公司登記」那個篩選現在是空的 —— 來源寫死】
 *
 * `gen_contract_recognitions` 寫入時第六個值是字串常數:
 *
 *     greatest(ms, ct.start_date), least(me, lease_end), 'longterm',
 *
 * 不管契約是長租、公司登記還是辦公室，認列一律標成 `longterm`。
 *
 * 而營收表的來源篩選（`revenues/page.tsx:44`）分成三個:
 *
 *     longterm 長租 ／ company 公司登記 ／ office 辦公室租金
 *
 * ★★★ 所以 649 筆公司登記的營收**全部被算進「長租」**，
 *   而「公司登記」那個選項一筆都篩不到 —— 篩出空白，
 *   看的人只會以為「這個月沒有公司登記的收入」。
 *
 * 契約的 `type` 跟認列的 `source` 本來就是一對一
 * （`contracts/page.tsx:61` 的 `TYPE_SRC`），所以改成寫契約自己的類別。
 *
 * ⚠⚠ 這會讓營收表上「長租」的金額**變小**、「公司登記」憑空出現。
 *   **總額不變，是分類歸位。** 八月若已照現在的數字對過帳，會對不起來。
 *
 * ★ `case when ct.type in (三種) ... else 'longterm' end` ——
 *   type 是 null 或冒出第四種值時退回 longterm，
 *   而不是讓營收表多出一個沒有標籤的來源（那會顯示成空白）。
 *
 * ============================================================
 * 【C. office 訂單會撞唯一索引 —— 早退條件用錯欄位】
 *
 * `gen_recognitions` 的早退條件寫的是 `o.source = 'longterm'`，
 * 但契約產生的月租單有三種 source。所以 office 的月租單**兩邊都會寫**:
 *
 *     gen_recognitions          → 一列（contract_id 空、source=office）
 *     gen_contract_recognitions → 一列（contract_id 有、同一個 order_id + ym）
 *     → ERROR: 23505 duplicate key ... uq_recognition_order_month
 *
 * ★★ 修法**不是**去改 `gen_recognitions` —— 那支還有短租、一次性收入在用，
 *   而我手上沒有它線上版本的完整原始碼。改**呼叫它的那一行**就夠了，
 *   而且範圍看得見:契約的租金單不要走訂單那條路。
 *
 * ★ 判斷用的是 `imported_via = 'contract'`，跟 `gen_contract_recognitions`
 *   自己挑訂單時用的 where **完全同一句** —— 不是我另外定義的規則
 *   （CLAUDE.md:「同一條規則在三個地方各寫一次」）。
 *
 * ★★★ 但 `oneoff` / `airbnb_cancelled` 要**排除在排除之外**。
 *   那 137 筆是加費子訂單，`gen_contract_recognitions` 只算月租，
 *   不會替它們產生任何東西 —— 一起跳過的話，加費收入會無聲消失，
 *   而那正是這支要修的那種 bug。
 */


-- ══════════════════════════════════════════════════════════
-- ⓪ 先擋：線上的 gen_contract_recognitions 是不是我看過的那一版
-- ══════════════════════════════════════════════════════════
/*
 * ★★★ 下面第 ② 段是**整支函式覆蓋**，而我手上的底稿是
 *   `archive/migrations-100-145/migration_138_recognition_independent.sql`
 *   （倉庫裡最後一次定義它的地方）。
 *
 *   線上如果被別人改過而我照蓋，那些改動會**靜靜消失** ——
 *   不報錯、不留痕跡，只有幾個月後某個數字對不起來。
 *
 * ★ 所以先驗三個指紋。對不上就 raise exception ——
 *   SQL Editor 把整份腳本包在一個交易裡，中止等於什麼都沒發生。
 *   到時候把線上的原始碼貼給我，我改完再來一次。
 */
do $do$
declare src text; n_lt int;
 begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'gen_contract_recognitions'
     and p.prokind in ('f','p');          -- ★ 不加會掃到聚合函式而爆掉

  if src is null then
    raise exception '找不到 public.gen_contract_recognitions —— 中止';
  end if;

  /*
   * 已經跑過一次了 —— 底下三個指紋是描述**舊版**的，這時候一定對不上。
   * 直接跳過，後面每一段都是冪等的（重算會先 delete 再寫）。
   */
  if position('migration_199' in src) > 0 then
    raise notice '已經是 migration_199 的版本，跳過指紋檢查';
    return;
  end if;

  -- 指紋①：'longterm' 這個字串常數只出現一次（就是要改掉的那個）
  n_lt := (length(src) - length(replace(src, '''longterm''', ''))) / 10;
  if n_lt <> 1 then
    raise exception
      '線上版本裡 ''longterm'' 出現 % 次（我看過的版本是 1 次）—— 中止，不覆蓋。請把 pg_get_functiondef 的結果貼給我', n_lt;
  end if;

  -- 指紋②：用 contract_id 清除（migration_138 改的，137 是用 order_id）
  if position('contract_id = ct.id' in src) = 0 then
    raise exception '線上版本沒有「delete ... where contract_id = ct.id」—— 不是我看過的那一版，中止';
  end if;

  -- 指紋③：挑訂單時用 imported_via = 'contract'
  if position('imported_via' in src) = 0 then
    raise exception '線上版本沒有用 imported_via 挑訂單 —— 不是我看過的那一版，中止';
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- ① 跑之前的樣子（自檢要拿來對照）
-- ══════════════════════════════════════════════════════════
/*
 * ★ 基準值**不依賴這支改了幾列** —— 存的是「跑之前各來源各多少錢」，
 *   而那是一個跟改動無關的量（CLAUDE.md:migration_187 踩過的坑）。
 */
create temp table _b199 on commit drop as
select source, count(*)::int as cnt, coalesce(sum(month_amount), 0) as amt
  from public.revenue_recognitions
 where ym = '202608'
 group by source;

create temp table _chk199 (item text, val text) on commit drop;


-- ══════════════════════════════════════════════════════════
-- ② trigger：刪的時候放過契約的認列；契約的租金單不走訂單那條路
-- ══════════════════════════════════════════════════════════
/*
 * ★★ 函式本體的第一行**不能是 `begin`**（2026-09-01 踩過）。
 *
 *   Supabase SQL Editor 的斷句器看到行首的 `begin` 會當成「開始交易」，
 *   在那裡把語句切開 —— Postgres 收到一句孤零零的 `begin`，
 *   然後是沒有主人的 `if`，回 `syntax error at or near "if"`。
 *
 * ★ migration_194／195 的函式能跑，是因為它們第一行是 `declare`。
 */
create or replace function public.trg_orders_recog() returns trigger
  language plpgsql security definer set search_path to 'public'
as $fn$
declare
  v_op   text := tg_op;
  v_rent boolean;
 begin
  if v_op in ('UPDATE','DELETE') then
    /*
     * ★★★ `and contract_id is null` 是 A 的全部重點。
     *
     *   契約產生的認列雖然掛著 order_id，但它的主人是契約 ——
     *   訂單被動一下就把它刪掉，而 gen_recognitions 對契約長租
     *   直接 return，補不回來。
     *
     * ★ 這樣改之後，契約的認列只由 gen_contract_recognitions 增刪
     *   —— **寫的人只有一個**。
     */
    delete from revenue_recognitions
     where order_id = old.id
       and contract_id is null;
  end if;

  if v_op in ('INSERT','UPDATE') then
    /*
     * ★★★ C:契約的**租金單**不要再走訂單那條路產生認列 ——
     *   那會跟 gen_contract_recognitions 寫的那一列撞唯一索引。
     *
     * ★★ 加費子訂單（oneoff／取消費）**要照走**。
     *   gen_contract_recognitions 只算月租，不會替它們產生任何東西，
     *   一起跳過的話那 137 筆加費收入會無聲消失。
     */
    v_rent := new.contract_id is not null
          and new.imported_via = 'contract'
          and coalesce(new.source, '') not in ('oneoff', 'airbnb_cancelled');
    if not v_rent then
      perform gen_recognitions(new);
    end if;
  end if;

  return coalesce(new, old);
end $fn$;

comment on function public.trg_orders_recog() is
  '訂單變動時重算認列（migration_199）。'
  '★★★ 刪除只碰 contract_id is null 的列 —— 契約產生的認列不歸訂單管，'
  '刪了 gen_recognitions 也補不回來（南京 202608 少 $166,000 就是這樣來的）。'
  '★★ 契約的租金單（imported_via=''contract'' 且非 oneoff）不呼叫 gen_recognitions，'
  '否則 office/company 兩邊都寫會撞 uq_recognition_order_month。';


-- ══════════════════════════════════════════════════════════
-- ③ 認列的來源改成契約自己的類別
-- ══════════════════════════════════════════════════════════
/*
 * 底稿是 migration_138 那一版，這次只改三處，其餘一字不動:
 *
 *   1. `'longterm'` → v_src（契約的 type）                      ← B
 *   2. 挑訂單前把 oid／pid 清成 null                            ← 見下方 ★★★
 *   3. 挑訂單時避開「那個 (order_id, ym) 已經有人佔著」的       ← C 的保險
 */
create or replace function public.gen_contract_recognitions(ct contracts)
returns void language plpgsql security definer as $fn$
declare
  ms date; me date; lease_end date;
  n int; dim int; amt numeric;
  total numeric := 0; acc numeric := 0;
  last_ms date := null;
  ename text; pname text; pid uuid;
  oid uuid;
  v_src text;   -- migration_199
 begin
  if ct.start_date is null or ct.end_date is null
     or ct.monthly_rent is null or ct.monthly_rent <= 0 then return; end if;

  /*
   * ★★★ B:寫契約自己的類別，不要寫死 'longterm'。
   *
   *   對照 contracts/page.tsx:61
   *     const TYPE_SRC = { longterm:'longterm', company:'company', office:'office' };
   *
   * ★ 落到 else 的（type 是 null、或哪天多出第四種）退回 longterm，
   *   而不是原樣寫進去 —— 營收表的 SRC_LABEL 查不到就顯示空白，
   *   那筆錢會變成「有金額、沒有來源」而沒有人看得懂。
   */
  v_src := case when ct.type in ('longterm','company','office')
                then ct.type else 'longterm' end;

  lease_end := (ct.end_date + 1)::date;
  select e.name into ename from estates e where e.id = ct.estate_id;

  /*
   * 清掉這份契約的既有認列。
   *
   * **用 contract_id 清，不再走 order_id**（migration_138）——
   * 走訂單的話,那些 order_id 是 null 的列永遠清不掉,
   * 每跑一次就多一份,而畫面上看起來只是「這個月的收入變兩倍」。
   */
  delete from revenue_recognitions where contract_id = ct.id;

  if not ct.active then return; end if;

  -- ── 第一趟：總額與最後一個月 ──
  ms := date_trunc('month', ct.start_date)::date;
  while ms < lease_end loop
    me := (ms + interval '1 month')::date;
    n  := least(me, lease_end) - greatest(ms, ct.start_date);
    if n > 0 then
      dim     := me - ms;
      total   := total + ct.monthly_rent::numeric * n / dim;
      last_ms := ms;
    end if;
    ms := me;
  end loop;
  total := round(total);

  -- ── 第二趟：寫入。**每一個月都寫，有沒有訂單都寫** ──
  ms := date_trunc('month', ct.start_date)::date;
  while ms < lease_end loop
    me := (ms + interval '1 month')::date;
    n  := least(me, lease_end) - greatest(ms, ct.start_date);
    if n > 0 then
      dim := me - ms;
      if ms = last_ms then amt := total - acc;
      else amt := trunc(ct.monthly_rent::numeric * n / dim); acc := acc + amt; end if;

      /*
       * ★★★ 先清成 null。plpgsql 的 `select ... into` **找不到列時不會清空變數**，
       *   上一個月挑到的 oid 會原封不動留著 —— 於是這個月的認列掛到
       *   上個月那張訂單上，而 (order_id, ym) 不同所以索引也擋不住。
       *   （138 就有這個洞，只是沒被踩到而已。）
       */
      oid := null; pid := null;

      -- 挑重疊最多的訂單來掛。**找不到就掛 null,那一列照樣存在**
      select o.id, o.property_id into oid, pid
        from orders o
       where o.contract_id = ct.id and o.imported_via = 'contract'
         and o.checkin < me and o.checkout > ms
         /*
          * ★★ 那個 (order_id, ym) 已經有別人的認列就跳過這張，換下一張。
          *   order_id 只影響回查、不影響金額（138 的註解），
          *   所以寧可掛 null 也不要整支 migration 撞 23505 回滾。
          */
         and not exists (
           select 1 from revenue_recognitions r
            where r.order_id = o.id
              and r.ym = to_char(ms, 'YYYYMM'))
       order by (least(o.checkout, me) - greatest(o.checkin, ms)) desc, o.checkin
       limit 1;

      select p.name into pname from properties p where p.id = pid;
      pname := coalesce(pname, ct.room);

      insert into revenue_recognitions(
        order_id, contract_id, ym, period_start, period_end, source,
        estate_id, property_id, estate_name, property_raw, guest_name,
        checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type)
      values (
        oid, ct.id, to_char(ms, 'YYYYMM'),
        greatest(ms, ct.start_date), least(me, lease_end), v_src,
        ct.estate_id, pid, ename, pname, ct.tenant_name,
        ct.start_date, lease_end,
        ct.monthly_rent, dim, n, amt, null);
    end if;
    ms := me;
  end loop;
end $fn$;

comment on function public.gen_contract_recognitions(contracts) is
  '長租認列。**只看契約 —— 訂單有沒有開、開幾張、怎麼繳都不影響**（migration_138）。'
  '認列(某月) = 月租 × 該月落在租期內的天數 ÷ 該月天數。'
  '★★★ source 寫**契約自己的 type**（longterm／company／office，migration_199）—— '
  '寫死 longterm 的話「公司登記」那個篩選一筆都篩不到，而 649 筆會混進長租。'
  'order_id 找不到、或那個 (order_id, ym) 已被佔用，就掛 null —— 只影響回查,不影響金額。';


-- ══════════════════════════════════════════════════════════
-- ④ 清掉孤兒認列（不然重建會撞唯一索引）
-- ══════════════════════════════════════════════════════════
/*
 * 【那批是什麼】
 *
 *   `contract_id` 是**空的**，但 `order_id` 指向一張契約的**租金單**。
 *   它們是舊 trigger 留下的:訂單被動過 → 契約那列被刪 →
 *   gen_recognitions 又補了一列不帶 contract_id 的。
 *
 *   `gen_contract_recognitions` 只用 `contract_id = ct.id` 清除，
 *   所以清不到它們；而重建時新的那一列 `(order_id, ym)` 跟它們一樣
 *   → ERROR: 23505 duplicate key。
 *
 * 【為什麼可以刪】
 *
 *   那些月份的認列本來就該由契約重新產生 —— 下面第 ⑤ 段馬上就會補回來，
 *   金額只會更完整（少的那些也一起補上）。
 *
 * ★★ 加費子訂單（oneoff／取消費）**排除在外**。那 137 筆的認列
 *   只有 gen_recognitions 會產生，刪了沒有人補 —— 這正是 A 的那種 bug。
 *
 * ★ 先數再刪，數字進自檢表 —— 刪掉多少錢要看得到，不能靜靜消失。
 */
insert into _chk199
select '④ 清掉的孤兒認列',
       coalesce(string_agg(x.line, E'\n' order by x.source), '（沒有）')
  from (
    select r.source,
           r.source || '：' || count(*)::text || ' 筆 ／ $'
             || coalesce(sum(r.month_amount), 0)::text as line
      from public.revenue_recognitions r
      join public.orders o on o.id = r.order_id
     where r.contract_id is null
       and o.contract_id is not null
       and o.imported_via = 'contract'
       and coalesce(o.source, '') not in ('oneoff', 'airbnb_cancelled')
     group by r.source
  ) x;

delete from public.revenue_recognitions r
 using public.orders o
 where o.id = r.order_id
   and r.contract_id is null
   and o.contract_id is not null
   and o.imported_via = 'contract'
   and coalesce(o.source, '') not in ('oneoff', 'airbnb_cancelled');


-- ══════════════════════════════════════════════════════════
-- ⑤ 全部契約重算
-- ══════════════════════════════════════════════════════════
/*
 * `gen_contract_recognitions` 自己會先 `delete where contract_id = ct.id`
 * 再重寫，所以重跑是冪等的 —— 跑第二次不會變成兩份。
 *
 * ★ 停用的契約它會刪完就 return（`if not ct.active then return`）——
 *   那是既有行為，這支不改，但自檢第 ⑥ 列會把影響數字報出來。
 */
do $do$ declare c public.contracts; begin
  for c in select * from public.contracts loop
    perform public.gen_contract_recognitions(c);
  end loop;
end $do$;


-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('199_recog_keep_contract');
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ ① 202608 各來源：跑之前 → 現在',
         (select string_agg(
                   coalesce(s.source, b.source) || '　'
                   || coalesce(b.cnt, 0)::text || ' 筆 $' || coalesce(b.amt, 0)::text
                   || '　→　' || coalesce(s.cnt, 0)::text || ' 筆 $' || coalesce(s.amt, 0)::text,
                   E'\n' order by coalesce(s.source, b.source))
            from _b199 b
            full join (
              select source, count(*)::int cnt, coalesce(sum(month_amount), 0) amt
                from public.revenue_recognitions where ym = '202608' group by source
            ) s on s.source = b.source),
         '★★ longterm 會變小、company／office 會冒出來 —— 那是分類歸位。'
           || '兩邊的**總額**應該只增不減（增加的是被刪掉又補回來的那些）'

  union all
  select 2, '★★★ ② trigger 兩個修正都在',
         (select case
                   when d ilike '%contract_id is null%' and d ilike '%imported_via%'
                     then '✅ 刪除帶了 contract_id is null，而且會跳過契約租金單'
                   when d ilike '%contract_id is null%'
                     then '⚠⚠ 只有刪除那半 —— office 的訂單一存檔就會撞唯一索引'
                   else '⚠⚠⚠ 沒生效 —— 訂單一被更新，契約的認列又會消失' end
            from (select pg_get_functiondef(p.oid) d
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.prokind in ('f','p')
                     and p.proname = 'trg_orders_recog') z),
         '★ 這是全支的重點。少了它，補回來的認列下次收款就再消失一次'

  union all
  select 3, '★★★ ③ 每張有效契約的認列月數都齊了',
         (select case when count(*) = 0 then '✅ 全部齊'
                      else '⚠ 有 ' || count(*)::text || ' 張還缺：'
                           || string_agg(room || '（' || got::text || '/' || want::text || '）', '、') end
            from (
              select c.room,
                     (select count(*) from public.revenue_recognitions r
                       where r.contract_id = c.id) got,
                     (select count(*) from generate_series(
                                date_trunc('month', c.start_date),
                                date_trunc('month', c.end_date),
                                interval '1 month')) want
                from public.contracts c
               where c.active
                 and c.start_date is not null and c.end_date is not null
                 and coalesce(c.monthly_rent, 0) > 0
            ) x
           where got <> want),
         '★ 停用／沒日期／沒租金的契約本來就沒有認列，不算在內'
           || '（194 那次沒做到合法形狀的排除，6 筆誤報差點淹掉真的那 1 筆）'

  union all
  select 4, '④ 清掉的孤兒認列',
         (select coalesce(string_agg(val, E'\n'), '（沒有）') from _chk199),
         '★ 那是舊 trigger 留下的殘留。同樣的月份第 ⑤ 段已經由契約重新產生，'
           || '所以第 ① 列的總額不該因為這一步變少'

  union all
  select 5, '★★ ⑤ 認列的來源分布（全部期間）',
         (select string_agg(source || '　' || cnt::text || ' 筆', E'\n' order by source)
            from (select source, count(*) cnt
                    from public.revenue_recognitions group by source) y),
         '★ company 要從 0 變成 600 多筆 —— 那就是營收表「公司登記」篩得到的量'

  union all
  select 6, '⚠ ⑥ 停用契約：它的租金單現在沒有認列了',
         (select case when count(*) = 0 then '✅ 沒有這種情況'
                      else count(*)::text || ' 張停用契約，'
                           || '底下 ' || sum(n_ord)::text || ' 張租金單沒有任何認列' end
            from (
              select c.id,
                     (select count(*) from public.orders o
                       where o.contract_id = c.id and o.imported_via = 'contract'
                         and coalesce(o.source,'') not in ('oneoff','airbnb_cancelled')
                         and not exists (select 1 from public.revenue_recognitions r
                                          where r.order_id = o.id)) n_ord
                from public.contracts c where not c.active
            ) w where n_ord > 0),
         '★★ gen_contract_recognitions 對停用契約是「刪完就 return」（既有行為，這支沒改）。'
           || '本來 office/company 還有訂單那條路撐著，現在那條路關了 —— '
           || '**這一列不是 0 的話跟我說，要不要保留歷史營收是你決定**'

  union all
  select 7, '⑦ 南京 202608 明細',
         coalesce((select string_agg(r.property_raw || '　' || r.source || '　$'
                                       || r.month_amount::text, E'\n' order by r.property_raw)
                     from public.revenue_recognitions r
                    where r.ym = '202608' and r.estate_name = '南京'), '（一筆都沒有 —— 不對）'),
         '★ 要看到 南京10-1 20000、南京10-2 17000、南京10-3 30000、'
           || '南京5 99000、南京6 46000 —— 合計比原本多 $166,000'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
