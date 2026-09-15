/*
 * migration_253_deposit_guard_fix.sql　2026-09-15
 * 押金守衛：只擋「動到錢」的欄位，別把改名字也算進去
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *
 * ══════════════════════════════════════════════════════════
 * 【症狀】
 *
 * 編輯契約（19B3）把租戶名字從「Luck」改成「碩美股份有限公司」，按儲存跳：
 *
 *     儲存失敗:2026-08 已經關帳，這筆押金動不了。
 *
 * 使用者沒有碰押金 —— 而且他說「還沒收押金呀」。
 *
 * 【查出來的事實】
 *
 * 那張契約底下有兩列押金，`guest_name` 都還是舊的「Luck」：
 *
 *     kind=deposit   $350,000   received_on = null        ← 還沒收，對
 *     kind=earnest   $175,000   received_on = 2026-08-17  ← **訂金收過了**
 *
 * 契約存檔會連帶把新名字同步到這兩列。而訂金那一列的收款月是
 * 已關帳的 202608 —— 守衛就把「改名字」擋下來了。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 真正的錯：`else hit_recv := true`】
 *
 * 249 的守衛逐欄比對，然後：
 *
 *     received_%  → 算「動到收」
 *     returned_%  → 算「動到退」
 *     **其餘一律** → 算「動到收」   ← 這一行
 *
 * 那條萬用分支把 `guest_name`、`room`、`note`、`updated_at`
 * 全部當成動錢。**關帳鎖的是錢，不是名字。**
 *
 * ★ 這是 README 坑 F 的反面:白名單該用「性質」列。
 *   「其餘都算錢」看起來保守，實際上是把不相干的操作一起擋死 ——
 *   而症狀出現在別的地方（使用者在改契約，訊息講的是押金）。
 *
 * ★★ 改成**逐欄分類**，而且自檢會把「沒有被分類到的欄位」列出來 ——
 *   以後 deposits 多一個欄位，看得到它落在哪一邊，不會安靜地漏掉。
 *
 * ══════════════════════════════════════════════════════════
 * 【順便補 249 的另外兩個洞】
 *
 * ② **連帶寫入也丟例外，害母操作整個失敗**
 *    orders 的守衛用 `pg_trigger_depth()` 分「人直接改」與「觸發器連帶寫」，
 *    押金那支沒有。所以一筆關帳月份的押金會讓那張契約**永遠存不了**，
 *    而訊息指向使用者沒碰過的東西 —— 223 的註解警告過這個形狀。
 *
 * ③ **不認 250 的臨時解鎖，訊息也還停在舊的**「去權限管理 → 關帳」。
 * ══════════════════════════════════════════════════════════
 */

begin;

create temp table _m253_test (ord int, name text, detail text, verdict text);

create or replace function public.deposits_period_lock_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  oj jsonb; nj jsonb; k text;
  hit_recv boolean := false;
  hit_ret  boolean := false;
  ym_recv  text;
  ym_ret   text;
  blocked  text;
  v_ct     uuid;
begin
  oj := to_jsonb(coalesce(old, new));
  v_ct := nullif(oj ->> 'contract_id', '')::uuid;
  ym_recv := nullif(replace(left(coalesce(oj ->> 'received_on', ''), 7), '-', ''), '');

  if tg_op = 'DELETE' then
    if ym_recv is not null and public.is_period_locked(ym_recv) then
      blocked := ym_recv;
    end if;
  else
    nj := to_jsonb(new);
    for k in select jsonb_object_keys(nj) loop
      if oj -> k is distinct from nj -> k then
        /*
         * ★★★ 逐欄分類（migration_253）。**只有動到錢才算**。
         *
         *   249 寫的是「received_% 算收、returned_% 算退、**其餘一律算收**」，
         *   於是改租戶名字、改房號、甚至 updated_at 都被當成動錢 ——
         *   而症狀出現在別的地方:使用者在改契約，訊息講的是押金。
         *
         * ★ 沒有列到的欄位（名字、房號、備註、時間戳、轉移紀錄、簽核欄）
         *   一律**不擋**。自檢第 ① 條會把沒分類到的欄位列出來，
         *   以後多一個欄位看得見它落在哪一邊。
         */
        if k like 'received%' or k in ('amount', 'currency', 'lines', 'kind') then
          hit_recv := true;
        elsif k like 'returned%' or k like 'refund%'
           or k like 'forfeit%' or k like 'planned_refund%' then
          hit_ret := true;
        end if;
      end if;
    end loop;

    if tg_op = 'INSERT' then hit_recv := true; end if;

    -- ★ 沒有一欄動到錢 → 放行。改名字就走這一條
    if not hit_recv and not hit_ret then
      return new;
    end if;

    ym_ret := nullif(replace(left(coalesce(nj ->> 'returned_on', oj ->> 'returned_on', ''), 7), '-', ''), '');

    if hit_recv and ym_recv is not null and public.is_period_locked(ym_recv) then
      blocked := ym_recv;
    elsif hit_ret and ym_ret is not null and public.is_period_locked(ym_ret) then
      blocked := ym_ret;
    end if;
  end if;

  if blocked is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- ★★ 會計在那一期按過開鎖 → 放行（migration_250）。押金綁契約，用 contract_id 對
  if v_ct is not null and public.has_period_unlock(blocked, null, v_ct) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  /*
   * ★★★ 觸發器連帶寫的（深度 ≥2）→ **不寫，但也不報錯**。
   *
   *   最常見的就是「改契約 → 同步押金」。在這裡丟例外的話
   *   **整張契約存不了**，而訊息講的是押金 ——
   *   223 的註解白紙黑字警告過這個形狀，我在 249 又原樣做了一次。
   *
   * ★ 代價:已關帳月份的押金，從契約那邊改**金額**不會跟著變
   *   （改名字這種非金錢欄位上面已經放行了，不受影響）。
   *   自檢第 ③ 條把對不上的列出來 —— 不會消失，只是要人看一眼。
   */
  if pg_trigger_depth() > 1 then
    return null;
  end if;

  raise exception '% 已經關帳，這筆押金的金額動不了。要改的話請會計在那一期按「開鎖」。',
    substr(blocked, 1, 4) || '-' || substr(blocked, 5, 2)
    using errcode = 'check_violation';
end $fn$;

comment on function public.deposits_period_lock_guard() is
  '關帳後押金的**金額**動不了（249 → 253 修三個洞）。'
  '★ 只有動到錢的欄位才算:received_% / amount / currency / lines / kind 看收款月，'
  'returned_% / refund_% / forfeit_% 看退還月。名字、房號、備註、時間戳一律放行。'
  '★★ 深度 ≥2（改契約連帶同步）不寫也不報錯，不然整張契約存不了。'
  '★★★ 認 period_unlock 的臨時開鎖。';

drop trigger if exists trg_deposits_period_lock on public.deposits;
create trigger trg_deposits_period_lock
  before insert or update or delete on public.deposits
  for each row execute function public.deposits_period_lock_guard();

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('253_deposit_guard_fix');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自　檢
-- ══════════════════════════════════════════════════════════
do $do$
declare
  v_id uuid; v_ym text; v_name text; v_err text := '';
  ok_name boolean := false;   -- 改名字放行
  ok_money boolean := false;  -- 改金額擋住
begin
  select d.id, replace(left(d.received_on::text, 7), '-', ''), d.guest_name
    into v_id, v_ym, v_name
    from public.deposits d
   where d.received_on is not null
     and public.is_period_locked(replace(left(d.received_on::text, 7), '-', ''))
   limit 1;

  if v_id is null then
    insert into _m253_test values
      (4, '④ 押金守衛實測', '找不到「收款月已關帳」的押金，測不了', '⚠ 沒測到');
    return;
  end if;

  begin
    -- (a) 改名字 —— 就是這次卡住的那個動作
    begin
      update public.deposits set guest_name = coalesce(v_name, '') || '・試' where id = v_id;
      ok_name := true;
    exception when others then
      ok_name := false; v_err := sqlerrm;
    end;

    -- (b) 改金額 —— 這個還是要擋
    begin
      update public.deposits set received_amount = coalesce(received_amount, 0) + 1 where id = v_id;
      ok_money := false;
    exception when others then
      ok_money := (sqlerrm like '%已經關帳%');
    end;

    raise exception 'M253_ROLLBACK';
  exception when others then
    if sqlerrm <> 'M253_ROLLBACK' then v_err := coalesce(nullif(v_err, ''), sqlerrm); end if;
  end;

  insert into _m253_test values
    (4, '④ 押金守衛實測（' || v_ym || '，改完已退掉）',
     '改名字放行：' || ok_name || '　改金額擋住：' || ok_money
       || case when v_err <> '' then '　（' || left(v_err, 70) || '）' else '' end,
     case when ok_name and ok_money then '✅ 該放的放、該擋的擋' else '❌' end);
end $do$;

select v.ord, v."檢查", v."結果", v."判定" from (

  /*
   * ★★★ 每一個欄位都要分得出「算不算錢」。
   *   沒分類到的欄位＝改它不會被擋 —— 那多半是對的（名字、備註），
   *   但**要看得見**。以後 deposits 多一個金額欄，這一條會把它列出來。
   */
  select 1, '① deposits 有哪些欄位不算「動到錢」（改它們不會被擋）',
         coalesce((select string_agg(c.column_name, '　' order by c.column_name)
                     from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = 'deposits'
                      and c.column_name not like 'received%'
                      and c.column_name not like 'returned%'
                      and c.column_name not like 'refund%'
                      and c.column_name not like 'forfeit%'
                      and c.column_name not in ('amount', 'currency', 'lines', 'kind')),
                  '（沒有）'),
         '✅ 參考 —— 看一眼有沒有該算錢卻在這一排的'

  union all
  select 2, '② 三段修正都在守衛裡',
         (select string_agg(x.t, '　') from (
            select '欄位分類' as t where (select prosrc from pg_proc
              where oid = 'public.deposits_period_lock_guard()'::regprocedure) ~ 'currency'
            union all select '連帶寫入不報錯' where (select prosrc from pg_proc
              where oid = 'public.deposits_period_lock_guard()'::regprocedure) ~ 'pg_trigger_depth'
            union all select '認開鎖' where (select prosrc from pg_proc
              where oid = 'public.deposits_period_lock_guard()'::regprocedure) ~ 'has_period_unlock'
          ) x),
         case when (select prosrc from pg_proc
                     where oid = 'public.deposits_period_lock_guard()'::regprocedure)
                   ~ 'pg_trigger_depth'
               and (select prosrc from pg_proc
                     where oid = 'public.deposits_period_lock_guard()'::regprocedure)
                   ~ 'has_period_unlock'
               and (select prosrc from pg_proc
                     where oid = 'public.deposits_period_lock_guard()'::regprocedure)
                   ~ 'currency'
              then '✅ 三段都在' else '❌ 少了' end

  union all
  select 3, '③ 押金的名字跟契約對不上的（這次就是它卡住存檔）',
         coalesce((select string_agg(
                     coalesce(d.room, '?') || '：押金寫「' || coalesce(d.guest_name, '—')
                     || '」／契約是「' || coalesce(c.tenant_name, '—') || '」', '　')
                     from public.deposits d
                     join public.contracts c on c.id = d.contract_id
                    where coalesce(d.guest_name, '') is distinct from coalesce(c.tenant_name, '')),
                  '（都對得上）'),
         '✅ 參考 —— 跑完這支再存一次那張契約，名字就會同步過去'

  union all
  select t.ord, t.name, t.detail, t.verdict from _m253_test t

  union all
  select 5, '⑤ 收尾', '這支用 temp table，關掉分頁自己消失，不用清', '✅ 不留東西'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
