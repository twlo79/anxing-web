-- migration_171：管家看得到所有請款單的憑證圖
--
-- ============================================================
-- 【怎麼發現的】（migration_170 的實測，2026-08-24）
--
-- 假扮各角色查同一張請款單的憑證圖，數回幾列:
--
--     會計 accountant    ✅ 1 / 1
--     主管 manager       ✅ 1 / 1
--     總經理 super_admin ✅ 1 / 1
--     管家 housekeeper   ❌ 0 / 1
--
-- 原因是 can_see_receipt() 的 else 分支:
--
--     exists (select 1 from attachments a
--               join purchase_requests p on p.id = a.request_id
--              where a.path = p_path and p.requester_id = auth.uid())
--                                        ^^^^^^^^^^^^^^^^^^^^^^^^^^
--                                        只看得到「自己送的單」
--
--
-- ============================================================
-- 【為什麼要開放】（2026-08-24 使用者指定）
--
-- 管家在「請款單控管」看得到**所有人**的單:
-- 金額、項目、會計科目、憑證號碼、收款方的銀行帳號都看得到。
--
-- 只有圖看不到。而發票上的資訊（廠商、金額、品項）
-- 他在項目清單上本來就讀得到 —— **藏圖擋不住任何東西**，
-- 只是讓他在需要核對的時候得去找會計。
--
-- 這是「畫面說的話跟資料庫說的話不一致」的典型:
-- 同一張單，一半的欄位給看、一半不給，而且沒有任何說明。
--
--
-- ============================================================
-- 【只開 pr/，不動其他 prefix】
--
-- 路徑格式是 `<kind>/<母層id>/<uuid>.<副檔名>`（見 Receipts.tsx），
-- kind 有 pr / exp / dep / op / dp / of 六種。
--
--   pr/  請款單     ← 這支開放（使用者指定）
--   op/  訂單收款證明  已經開了（migration_154）
--   of/  訂單加費憑證  ← **這支也一起補**，見下面「額外修的一項」
--   exp/ 支出憑證     **不開** —— 管家沒有支出頁
--   dep/ 押金憑證     **不開** —— 押金頁他只能檢視，憑證是會計在對帳用的
--   dp/  押金收款證明  **不開** —— 同上
--
--
-- ============================================================
-- 【額外修的一項：`of/` 也沒開 —— 這不在原本的要求裡】
--
-- 對照線上的 can_see_receipt 定義（2026-08-24 實際查出來的）:
--
--     when current_role_of() in ('accountant','manager','super_admin') then true
--     when current_role_of() = 'housekeeper' and p_path like 'op/%' then true
--     else exists ( … requester_id = auth.uid() )
--
-- **只有 `op/`，沒有 `of/`。**
--
-- 而 migration_158 加的訂單加費憑證用的正是 `of/` 前綴，
-- 上傳介面 `<Receipts kind="of">` 就掛在管家用得到的訂單抽屜裡。
-- 也就是說:**管家傳得上去，但看不到自己剛傳的那張照片。**
--
-- 這是既有的 bug，跟這次的要求無關 —— 但它跟 pr/ 在同一支函式裡，
-- 分兩次改要 replace 兩次，而每一次 replace 都是一次覆蓋整支的風險。
-- 所以一起補，並在下面的自檢裡**單獨列一項**讓人看得到。
--
--
-- ============================================================
-- 【else 分支一個字都沒動】
--
-- 線上的 else 用的是 `join attachments … requester_id = auth.uid()`，
-- 跟這支寫的完全相同 —— 已逐字對照過。
-- （migration_154 的註解提到舊版曾用 split_part，那個版本已經不在線上。）
--
-- ★ 為什麼不把 housekeeper 寫進第一行的角色清單:
--   那一行是「不管什麼路徑都放行」，等於連 exp/ dep/ dp/ 一起開了。
--   這正是 migration_154 當初的取捨，這裡沿用。
--
--
-- ============================================================
-- 【只開「看」，不開「傳」與「刪」】
--
-- `can_edit_receipt()` **不動**。管家傳得了自己送的單的憑證
-- （else 分支的 requester_id 判斷還在），但改不了別人的。
--
-- 理由:看錯一張圖沒有後果,刪掉一張別人的發票有 ——
-- 而且刪掉之後只會少一張圖，沒有任何紀錄說是誰刪的。
-- 「看」與「改」要分開判斷，這是既有的做法。
-- ============================================================

create or replace function public.can_see_receipt(p_path text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select case
    when current_role_of() in ('accountant','manager','super_admin') then true
    -- 管家:訂單的收款證明（migration_154）
    when current_role_of() = 'housekeeper' and p_path like 'op/%' then true
    /*
     * ★ 管家:訂單加費的憑證（migration_158 的 of/ 前綴）。
     *   **原本漏了** —— 上傳介面就在他用得到的訂單抽屜裡，
     *   結果是傳得上去、看不到自己剛傳的照片。見檔頭「額外修的一項」。
     */
    when current_role_of() = 'housekeeper' and p_path like 'of/%' then true
    /*
     * ★ 管家:請款單的憑證圖（migration_171）。
     *   他在請款單控管本來就看得到那張單的全部欄位 —— 藏圖擋不住任何東西。
     *   只有 `pr/` 這一個前綴 —— exp、dep、dp 不在裡面，那些他沒有頁面可以進去。
     */
    when current_role_of() = 'housekeeper' and p_path like 'pr/%' then true
    -- 其他人只看得到自己送的請款單底下的附件
    else exists (
      select 1
      from public.attachments a
      join public.purchase_requests p on p.id = a.request_id
      where a.path = p_path and p.requester_id = auth.uid()
    )
  end;
$function$;

comment on function public.can_see_receipt(text) is
  '誰看得到這個路徑的憑證。會計以上全部；管家看得到 op/、of/、pr/；'
  '其他人只看得到自己送的請款單底下的（migration_171）。'
  '★ 寫入權限是另一支 can_edit_receipt —— 看與改要分開判斷。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('171_housekeeper_pr_receipt');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★★ 假扮身分 ＋ **切 role** 實際查一次（做法見 migration_170 檔頭）。
 *
 *   光設 jwt claims 不夠:SQL Editor 是 postgres 連線、是表的擁有者，
 *   而 RLS 預設對擁有者不套用 ——
 *   不切 role 的話每個角色都會數到全部，然後這張表會顯示一片 ✅，
 *   **而那是假的**。假的綠燈比紅燈危險。
 */
create temp table _chk171 (ord int, item text, result text, note text) on commit drop;

do $$
declare
  v_req uuid; v_total int; v_n int; v_msg text;
  v_roles text[]; v_ids uuid[]; i int;
  v_dep_path text; v_dep_n int;
begin
  select request_id into v_req from public.attachments
   where request_id is not null limit 1;
  if v_req is null then
    insert into _chk171 values (1, '★★ 憑證圖讀取權限', '⚠ 測不出來',
      '一張有圖的請款單都沒有');
    return;
  end if;

  select count(*) into v_total from public.attachments where request_id = v_req;
  insert into _chk171 values (1, '這張單實際有幾張圖', v_total::text || ' 張',
    '下面每個角色都應該數到這個數字');

  -- 押金憑證挑一張,等一下確認管家**沒有**被順手開放
  select path into v_dep_path from public.attachments
   where path like 'dep/%' limit 1;

  /*
   * ★ 角色樣本先讀進**陣列**再切 role。
   *   用游標或 temp table 的話，迴圈中途 role 已經是 authenticated，
   *   讀不到來源 —— 迴圈會少跑幾圈，而症狀是「有些角色沒出現在報告裡」。
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
      set local role authenticated;
      select count(*) into v_n from public.attachments where request_id = v_req;
      v_dep_n := null;
      if v_dep_path is not null then
        select count(*) into v_dep_n from public.attachments where path = v_dep_path;
      end if;
      reset role;

      v_msg := case
        when v_n = v_total then '✅ ' || v_n || ' / ' || v_total
        when v_n = 0 then '❌ 0 / ' || v_total || '（看不到）'
        else '⚠ ' || v_n || ' / ' || v_total end;

      -- 押金憑證有沒有被順手開放
      if v_roles[i] = 'housekeeper' and v_dep_n is not null then
        v_msg := v_msg || '　押金憑證:'
          || case when v_dep_n = 0 then '✅ 看不到' else '❌ 被一起開了' end;
      end if;
    exception when others then
      reset role;
      v_msg := '⚠ 例外:' || sqlerrm;
    end;

    insert into _chk171 values (
      2,
      case v_roles[i]
        when 'cleaner' then '　房務 cleaner'
        when 'housekeeper' then '　★★ 管家 housekeeper'
        when 'accountant' then '　會計 accountant'
        when 'manager' then '　主管 manager'
        when 'super_admin' then '　總經理 super_admin'
        else '　' || v_roles[i] end,
      v_msg,
      case v_roles[i]
        when 'housekeeper' then '★★ 這一列從 ❌ 變成 ✅ 就是這支的目的'
        when 'cleaner' then '房務照舊 —— 這支沒動他'
        else '本來就看得到' end);
  end loop;

  perform set_config('request.jwt.claims', '', true);
end $$;


select "檢查項目", "結果", "說明" from (

  select c.ord, c.item as "檢查項目", c.result as "結果", c.note as "說明"
    from _chk171 c

  union all
  /*
   * ★★ 寫入權限不能跟著鬆掉。
   *   can_edit_receipt 裡**不該**出現 pr/ 的 housekeeper 分支 ——
   *   管家看得到別人的發票,但刪不掉。
   */
  select 3, '★★ 寫入權限沒有跟著開',
         case when pg_get_functiondef('public.can_edit_receipt(text)'::regprocedure)
                   not like '%housekeeper%pr/%'
              then '✅ 只能看,不能改' else '❌ 連刪除也開了' end,
         '刪掉一張別人的發票沒有任何紀錄說是誰刪的'

  union all
  /*
   * ★ 三個 prefix 都在。少一個的症狀是「某一頁的照片突然不見」，
   *   而那不會報錯。
   */
  select 4, '★ 管家的三個路徑',
         (select string_agg(x, '、') from unnest(array['op/','of/','pr/']) x
           where pg_get_functiondef('public.can_see_receipt(text)'::regprocedure)
                 like '%housekeeper%' || x || '%'),
         '應為 op/、of/、pr/ 三個'

  union all
  /*
   * ★ 額外修的那一項單獨列出來 —— 它不在原本的要求裡，
   *   混在「三個路徑都在」裡面的話等於偷偷改了東西。
   */
  select 5, '★ 額外補的 of/（訂單加費憑證）',
         case when pg_get_functiondef('public.can_see_receipt(text)'::regprocedure)
                   like '%housekeeper%of/%' then '✅ 補上了' else '❌' end,
         '原本管家傳得上去卻看不到自己剛傳的照片'

  union all
  /*
   * ★★ can_edit_receipt 的完整定義印出來。
   *
   *   can_see 缺 of/ 這件事是查了才知道的 —— can_edit 有沒有同樣的洞，
   *   我沒有看過它的線上定義，**不猜**。
   *   印出來由人判斷:裡面應該要有 op/ 與 of/ 的 housekeeper 分支，
   *   而且**不該**有 pr/（管家不能刪別人的發票）。
   */
  select 6, '★★ can_edit_receipt 現行定義（請看一眼）',
         pg_get_functiondef('public.can_edit_receipt(text)'::regprocedure),
         '要有 op/ 與 of/，不該有 pr/'

  union all
  select 7, '請款單的憑證圖總數', count(*)::text || ' 張',
         '這支只改規則,一個檔案都沒動'
    from public.attachments where request_id is not null

) v order by ord;
