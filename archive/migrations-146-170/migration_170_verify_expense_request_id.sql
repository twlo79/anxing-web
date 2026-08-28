-- migration_170：補測 169 沒測到的兩件事（**不改任何東西**，只有 select）
--
-- ============================================================
-- 【169 的觸發器實測為什麼是 ⚠】
--
-- 我挑測試資料的條件是:
--
--     select i.id from purchase_request_items i
--      where i.request_id is not null limit 1;
--
-- 撈到的第一筆**已經有支出了**，所以 insert 撞上 source_item_id 的唯一索引，
-- `on conflict do nothing` 讓它什麼都沒做，`returning` 也就沒回任何列。
--
-- 修法很簡單:挑一個**還沒有支出**的項目。
--
--     and not exists (select 1 from expenses e where e.source_item_id = i.id)
--
-- 這是自檢的老問題:條件寫得太寬，撈到的樣本剛好測不到要測的東西，
-- 而結果看起來像「跳過」而不是「寫錯」。
--
--
-- ============================================================
-- 【順便補測憑證圖的讀取權限】
--
-- 169 的第 7 項只回了政策名稱 `att_read`，**沒有內容** ——
-- 那等於只知道「有一條政策」，不知道它讓誰看到什麼。
--
-- 支出頁讀請款單的圖走的是:
--
--     from('attachments').eq('request_id', <請款單 id>)
--
-- 這條路在 169 之前**從來沒有走通過**（request_id 一直是 null），
-- 所以 att_read 對它成不成立，從來沒有被驗證過。
--
-- 這裡用 168 的假扮身分技巧，實際以各角色查一次，數回幾列。
-- ============================================================


create temp table _chk170 (ord int, item text, result text, note text) on commit drop;


-- ============================================================
-- ① 觸發器實測（這次挑對樣本）
-- ============================================================
do $$
declare
  v_item uuid; v_req uuid; v_code text; v_got uuid; v_msg text;
begin
  select i.id, i.request_id into v_item, v_req
    from public.purchase_request_items i
   where i.request_id is not null
     -- ★ 這一行是 169 漏掉的。沒有它就會撈到已經有支出的項目
     and not exists (select 1 from public.expenses e where e.source_item_id = i.id)
   limit 1;

  select code into v_code from public.account_codes
   where book = 'anxing' and active limit 1;

  if v_item is null then
    insert into _chk170 values (1, '★★ 觸發器實測', '⚠ 測不出來',
      '每一個請款項目都已經有支出了 —— 沒有乾淨的樣本');
    return;
  end if;
  if v_code is null then
    insert into _chk170 values (1, '★★ 觸發器實測', '⚠ 測不出來', '找不到會計科目');
    return;
  end if;

  begin
    insert into public.expenses (
      spent_on, item_name, amount, amount_original, currency, fx_rate,
      account_code, purpose_type, payment_method, source_item_id, book
    ) values (
      current_date, '__170 觸發器測試__', 1, 1, 'TWD', 1,
      v_code, 'office', 'transfer', v_item, 'anxing'
    )
    returning request_id into v_got;

    if v_got is null then
      v_msg := '❌ 沒填 —— 觸發器沒生效';
    elsif v_got = v_req then
      v_msg := '✅ 自動填上了';
    else
      v_msg := '❌ 填錯了:' || v_got::text || '（應為 ' || v_req::text || '）';
    end if;

    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    -- expenses 上還有帳本與會計科目的觸發器,丟的是 check_violation。
    -- 只抓 restrict_violation 的話會炸掉整份腳本（README 9.4 第 9 條）
    if sqlerrm <> '__rollback__' then v_msg := '⚠ 例外:' || sqlerrm; end if;
  end;

  insert into _chk170 values (1, '★★ 觸發器實測', coalesce(v_msg, '⚠ 沒跑到'),
    '以後新產生的支出會不會自動帶 request_id');
end $$;


-- ============================================================
-- ② 各角色實際讀得到幾張憑證圖
-- ============================================================
/*
 * 挑一張**真的有圖**的請款單，假扮各角色查一次。
 *
 * ★★ 這裡跟 168 不一樣:**必須切 role**。
 *
 *   168 測的是 `trash_can_delete()`，那是一支函式，只看 `auth.uid()`，
 *   設 jwt claims 就夠了。
 *
 *   這裡測的是 **attachments 這張表的 RLS**。目前是 postgres 連線、
 *   是表的擁有者，而 **RLS 預設對擁有者不套用** ——
 *   不切 role 的話每個角色都會數到全部，然後我會回報「權限沒問題」，
 *   而那是假的。假的綠燈比紅燈危險。
 *
 *   代價:切成 authenticated 之後這支自己也讀不到 profiles 了。
 *   所以角色樣本要在切換**之前**先讀進陣列（見下面的說明）。
 */
do $$
declare
  v_req uuid; v_total int; v_n int; v_msg text;
  v_roles text[]; v_ids uuid[]; i int;
begin
  select request_id into v_req from public.attachments
   where request_id is not null limit 1;
  if v_req is null then
    insert into _chk170 values (2, '★★ 憑證圖讀取權限', '⚠ 測不出來',
      '一張有圖的請款單都沒有');
    return;
  end if;

  select count(*) into v_total from public.attachments where request_id = v_req;
  insert into _chk170 values (2, '這張單實際有幾張圖', v_total::text || ' 張',
    '下面每個角色應該都要數到這個數字');

  /*
   * ★★ 先把樣本讀進**陣列**，再開始切 role。
   *
   *   用 `for r in select … from profiles` 的話，游標在迴圈中途仍然在讀表，
   *   而那時 role 已經被切成 authenticated —— RLS 會擋掉它，
   *   迴圈可能提早結束或少跑幾圈。症狀是「有幾個角色沒出現在報告裡」，
   *   看起來像公司沒有那些人,而不是像 bug。
   *
   *   陣列在記憶體裡，切 role 影響不到。
   */
  select array_agg(s.role order by s.role), array_agg(s.id order by s.role)
    into v_roles, v_ids
    from (select distinct on (p.role) p.role, p.id
            from public.profiles p
           where p.active and p.role is not null
           order by p.role, p.id) s;

  for i in 1..coalesce(array_length(v_ids, 1), 0) loop
    begin
      perform set_config('request.jwt.claims',
                         json_build_object('sub', v_ids[i]::text)::text, true);
      /*
       * ★ 光設 jwt claims 不夠。
       *   目前是 postgres 連線、是表的擁有者，**RLS 預設對擁有者不套用** ——
       *   不切 role 的話每個角色都會數到全部，然後我會回報「權限沒問題」,
       *   而那是假的。
       */
      set local role authenticated;
      select count(*) into v_n from public.attachments where request_id = v_req;
      reset role;

      v_msg := case
        when v_n = v_total then '✅ ' || v_n || ' / ' || v_total
        when v_n = 0 then '❌ 0 / ' || v_total || '（看不到圖）'
        else '⚠ ' || v_n || ' / ' || v_total || '（只看得到一部分）' end;
    exception when others then
      reset role;
      v_msg := '⚠ 例外:' || sqlerrm;
    end;

    insert into _chk170 values (
      3,
      case v_roles[i]
        when 'cleaner' then '　房務 cleaner'
        when 'housekeeper' then '　管家 housekeeper'
        when 'accountant' then '　★ 會計 accountant'
        when 'manager' then '　主管 manager'
        when 'super_admin' then '　總經理 super_admin'
        else '　' || v_roles[i] end,
      v_msg,
      case v_roles[i]
        when 'accountant' then '★ 支出頁是給他看的 —— 這一列必須 ✅'
        when 'manager' then '審核請款單要看發票'
        when 'cleaner' then '看不到也沒關係,他沒有支出頁'
        else '' end);
  end loop;

  perform set_config('request.jwt.claims', '', true);
end $$;


-- ============================================================
-- ③ att_read 到底寫了什麼
-- ============================================================
/*
 * 169 只印了政策**名稱**。名稱說明不了任何事 ——
 * 要看到 using 條件才知道它讓誰看到什麼。
 */
insert into _chk170
select 4, 'att_read 的條件',
       coalesce(pg_get_expr(p.polqual, p.polrelid), '(沒有 using)'),
       '支出頁讀請款單的圖靠這一條'
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
 where c.relname = 'attachments' and p.polname = 'att_read';


select "檢查項目", "結果", "說明"
  from (select ord, item as "檢查項目", result as "結果", note as "說明"
          from _chk170) v
 order by ord;
