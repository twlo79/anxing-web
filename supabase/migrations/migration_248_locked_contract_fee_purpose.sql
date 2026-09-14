/*
 * migration_248_locked_contract_fee_purpose.sql　2026-09-14
 * 把關帳月份裡「用途沒跟上契約」的加費補正（247 的尾巴）
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *
 * ══════════════════════════════════════════════════════════
 * 【這是什麼】
 *
 * 247 的自檢第 ④ 條紅了 3 張，查出來是炒飯吧（契約類別＝辦公室、2F-2）
 * 2026-08 的三筆加費：
 *
 *     CRC_…_202608   contract_fee   $4,200
 *     CRC_…_202608   contract_fee   $367
 *     CFEE_cf0a290e  manual         $6,174     合計 $10,741
 *
 * 247 第 ⑦ 步的回填改不動它們，因為 **2026-08 關帳了**，
 * 而 `orders_period_lock_guard` 只對 `imported_via = 'contract'` 放行。
 * 這三筆是 `contract_fee` 與 `manual`，走的是「系統路徑」那一條：
 * **不寫、不報錯、記一筆到 `order_lock_pending`**。那是它該做的事。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼非補不可 —— 這是錢算錯邊，不是欄位不整齊】
 *
 * 這三筆的 `source` 是 `oneoff`，所以 `gen_recognitions` 有幫它們產認列
 * （早退那條只擋 `source = 'longterm' and contract_id is not null`）。
 * 認列的 `purpose_type` 直接抄訂單的 → 現在是 `'estate'`。
 *
 * 而前端 `inEstateBlock` 對 `'estate'` 是**納入**：
 * 這 $10,741 現在算在 2F-2 那個物業的營收裡，
 * 它應該在「安幸辦公室」那一段（`isHkOffice`）。
 *
 * ★★ 247 的自檢第 ⑤ 條之所以顯示 ✅、沒抓到它們：
 *   那一條是 join `revenue_recognitions.contract_id`，
 *   而 `gen_recognitions` **不寫 contract_id**（只寫 order_id）。
 *   所以那三列認列在第 ⑤ 條的視野之外。
 *   ——「兩個問法不同的檢查互相對照」又一次。這支改成**從訂單那邊追**。
 *
 * ★ 247 之前就是錯的:這三筆從建立那天起用途就是 estate。
 *   247 沒有把它們弄壞，是把它們照出來。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 這支會自己開鎖再鎖回去】
 *
 * 全部在同一個交易裡：記下哪些月本來是鎖的 → 打開 → 改 → 鎖回去。
 * 中途任何一步炸掉就整個 rollback，**鎖不會留在打開的狀態**。
 *
 * ★ 不寫死「2026-08」與「3 張」—— 一律從
 *   「訂單的用途 ≠ 契約的用途」現查。以後再有同樣的情形，
 *   這支原封不動再跑一次就好。
 * ══════════════════════════════════════════════════════════
 */

begin;

drop table if exists public._m248_test;
create table public._m248_test (ord int, name text, detail text, verdict text);

drop table if exists public._m248_before;
create table public._m248_before as
select o.id as order_id,
       o.order_key, o.source, o.imported_via, o.amount,
       o.purpose_type as ord_purpose,
       c.purpose_type as ct_purpose,
       c.type as ct_type,
       to_char(o.checkout, 'YYYYMM') as ym,
       (select coalesce(sum(r.month_amount), 0)
          from public.revenue_recognitions r where r.order_id = o.id) as recog_amount,
       (select count(*)
          from public.revenue_recognitions r where r.order_id = o.id) as recog_rows
  from public.orders o
  join public.contracts c on c.id = o.contract_id
 where o.purpose_type is distinct from c.purpose_type;

comment on table public._m248_before is
  'migration_248 改動前的對不上清單。自檢核對完可以 drop。';

/*
 * 鎖的原狀也要拍一張。
 *
 * ★★ 不能用「最後是不是全部鎖著」當自檢 —— 那幾個月裡可能本來就有
 *   被人手動打開的（`period_lock` 有列但 locked = false）。
 *   那種這支不會碰，而拿「全部都該是鎖著」去判會誤報 ❌，
 *   然後下一個人為了讓自檢變綠去把它鎖起來 —— 那才是真的改壞。
 */
drop table if exists public._m248_lock_before;
create table public._m248_lock_before as
select p.ym, p.locked
  from public.period_lock p
 where p.ym in (select distinct to_char(o.checkout, 'YYYYMM')
                  from public.orders o
                  join public.contracts c on c.id = o.contract_id
                 where o.purpose_type is distinct from c.purpose_type);

do $do$
declare
  v_locked text[];          -- 本來就是鎖著、被這支暫時打開的月份
  n_ord int; n_rec int; n_pend int;
begin
  if not exists (select 1 from public._m248_before) then
    insert into public._m248_test values
      (3, '③ 有沒有東西要補', '一張都沒有 —— 247 的第 ④ 條想必已經是綠的', '✅ 沒事做');
    return;
  end if;

  -- ── 記下哪些月是鎖著的，然後打開 ──────────────────────
  /*
   * ★ 只收「真的鎖著」的月份。沒鎖的月份不要寫進 period_lock ——
   *   那會多出一列 locked=false 的假紀錄，
   *   而下次 `close_due_periods()` 看到「這個月有人手動開過」會跳過它。
   */
  select coalesce(array_agg(distinct b.ym), '{}')
    into v_locked
    from public._m248_before b
   where public.is_period_locked(b.ym);

  if array_length(v_locked, 1) > 0 then
    update public.period_lock set locked = false where ym = any(v_locked);
  end if;

  -- ── 訂單：用途改成契約的 ──────────────────────────────
  -- （247 的 trg_order_purpose_from_contract 也會再確認一次）
  with up as (
    update public.orders o
       set purpose_type = c.purpose_type
      from public.contracts c
     where c.id = o.contract_id
       and o.purpose_type is distinct from c.purpose_type
    returning o.id)
  select count(*) into n_ord from up;

  /*
   * ── 認列：從**訂單**那邊追，不是從 contract_id ────────
   *
   * ★★★ 這就是 247 第 ⑤ 條漏掉它們的原因:
   *   `gen_recognitions` 產的認列只有 order_id，沒有 contract_id。
   *   這裡改成 join order_id，那三列才在視野裡。
   *
   * ★ `revenue_recognitions` 沒有關帳守門員（那支只裝在 orders 上），
   *   所以這一段不受鎖影響 —— 但還是放在開鎖區間內，
   *   萬一哪天認列也加了守門員，這支不用回來改。
   */
  with up as (
    update public.revenue_recognitions r
       set purpose_type = c.purpose_type
      from public.orders o
      join public.contracts c on c.id = o.contract_id
     where o.id = r.order_id
       and r.purpose_type is distinct from c.purpose_type
    returning r.id)
  select count(*) into n_rec from up;

  -- ── 鎖回去 ────────────────────────────────────────────
  if array_length(v_locked, 1) > 0 then
    update public.period_lock set locked = true where ym = any(v_locked);
  end if;

  /*
   * ── 清掉 247 那次被擋下來、現在已經套用的待處理紀錄 ──
   *
   * ★ 只刪**整筆只有 purpose_type 一個欄位**的。
   *   混著其他欄位的代表那筆還有別的改動沒套用，
   *   刪掉就等於把那些改動也一起丟了。
   */
  with del as (
    delete from public.order_lock_pending p
     where p.order_id in (select order_id from public._m248_before)
       and p.changes ? 'purpose_type'
       and (select count(*) from jsonb_object_keys(p.changes)) = 1
    returning p.order_id)
  select count(*) into n_pend from del;

  insert into public._m248_test values
    (3, '③ 補正做了什麼',
     '訂單 ' || n_ord || ' 張　認列 ' || n_rec || ' 列　'
       || '暫時打開又鎖回去的月份：' || coalesce(array_to_string(v_locked, '、'), '（沒有）')
       || '　清掉待處理 ' || n_pend || ' 筆',
     case when n_ord = (select count(*) from public._m248_before)
          then '✅ 該改的都改了' else '❌ 有沒改到的' end);
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('248_locked_contract_fee_purpose');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自　檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 每一張掛契約的訂單，用途都跟契約一致（247 的第 ④ 條）',
         '不一致 ' || (select count(*) from public.orders o
                        join public.contracts c on c.id = o.contract_id
                       where o.purpose_type is distinct from c.purpose_type)::text
         || ' 張　／　這次處理了 ' || (select count(*) from public._m248_before)::text || ' 張',
         case when (select count(*) from public.orders o
                     join public.contracts c on c.id = o.contract_id
                    where o.purpose_type is distinct from c.purpose_type) = 0
              then '✅ 全對上' else '❌ 還有對不上的' end

  union all
  /*
   * ★★★ 這一條是 247 第 ⑤ 條的**正確版本** —— 從 order_id 追，
   *   不是從 contract_id。`gen_recognitions` 不寫 contract_id，
   *   用那一欄去查的話這批永遠是隱形的。
   */
  select 2, '② 認列的用途跟它那張訂單一致（從 order_id 追，不是 contract_id）',
         '不一致 ' || (select count(*) from public.revenue_recognitions r
                        join public.orders o on o.id = r.order_id
                       where r.purpose_type is distinct from o.purpose_type)::text
         || ' 列　／　有掛訂單的認列共 '
         || (select count(*) from public.revenue_recognitions where order_id is not null)::text || ' 列',
         case when (select count(*) from public.revenue_recognitions r
                     join public.orders o on o.id = r.order_id
                    where r.purpose_type is distinct from o.purpose_type) = 0
              then '✅ 全對上' else '❌ 有對不上的' end

  union all
  select t.ord, t.name, t.detail, t.verdict from public._m248_test t

  union all
  /*
   * ★ 錢有沒有搬對邊。這三筆從「依物業」離開、進到「安幸辦公室」——
   *   金額一毛不變，只是換一段顯示。
   */
  select 4, '④ 這次從「依物業」搬走的金額',
         coalesce((select string_agg(g.txt, '　' order by g.ym)
                     from (select b.ym,
                                  b.ym || '：' || count(*)::text || ' 筆　$'
                                  || to_char(sum(b.recog_amount), 'FM9,999,999,999') as txt
                             from public._m248_before b
                            group by b.ym) g), '（沒有）')
         || '　←　這些原本算在物業的營收裡，現在算安幸辦公室',
         case when not exists (
                select 1 from public._m248_before b
                  join public.revenue_recognitions r on r.order_id = b.order_id
                 where r.purpose_type is distinct from b.ct_purpose)
              then '✅ 全部搬到契約的用途上了' else '❌ 有沒搬過去的' end

  union all
  select 5, '⑤ 認列金額一毛沒變（只換歸屬）',
         '改前 $' || to_char((select coalesce(sum(recog_amount), 0) from public._m248_before), 'FM9,999,999,999')
         || '　改後 $' || to_char((select coalesce(sum(r.month_amount), 0)
                                    from public.revenue_recognitions r
                                    join public._m248_before b on b.order_id = r.order_id), 'FM9,999,999,999'),
         case when (select coalesce(sum(recog_amount), 0) from public._m248_before)
                 = (select coalesce(sum(r.month_amount), 0)
                      from public.revenue_recognitions r
                      join public._m248_before b on b.order_id = r.order_id)
              then '✅ 一樣' else '❌ 金額被動到了' end

  union all
  /*
   * ★★★ 最重要的一條:**鎖有沒有回到原狀**。
   *   這支中途把月份打開過，忘了鎖回去的話
   *   那個月就變成可以隨便改 —— 而沒有任何地方會提醒。
   */
  select 6, '⑥ 關帳的鎖回到原狀了（跟改動前逐月比對，不是「是不是全鎖著」）',
         coalesce((select string_agg(
                     b.ym || '：' || case when b.locked then '鎖' else '開' end
                            || '→' || case when p.locked then '鎖' else '開' end, '　' order by b.ym)
                     from public._m248_lock_before b
                     join public.period_lock p on p.ym = b.ym), '（那幾個月本來就沒有關帳紀錄）')
         || '　｜這支新增的列：'
         || coalesce((select string_agg(p.ym, '、' order by p.ym)
                        from public.period_lock p
                       where p.ym in (select distinct ym from public._m248_before)
                         and not exists (select 1 from public._m248_lock_before b where b.ym = p.ym)),
                     '（沒有，本來就不該有）'),
         case when not exists (
                select 1 from public._m248_lock_before b
                  join public.period_lock p on p.ym = b.ym
                 where p.locked is distinct from b.locked)
               and not exists (
                select 1 from public.period_lock p
                 where p.ym in (select distinct ym from public._m248_before)
                   and not exists (select 1 from public._m248_lock_before b where b.ym = p.ym))
              then '✅ 跟改動前一模一樣' else '❌ 鎖的狀態被改掉了' end

  union all
  select 7, '⑦ 收尾',
         '核對完請執行：drop table public._m248_before; drop table public._m248_lock_before; '
         || 'drop table public._m248_test; drop table public._m247_before; drop table public._m247_test;',
         '⚠ 記得清掉這五張暫存表'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
