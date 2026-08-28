-- migration_149：退回草稿時由資料庫清票，前端不再碰核可欄位
--
-- ============================================================
-- 【症狀】（2026-08-19）
--
-- 會計編輯自己送出的請款單（狀態 pending、已經有主管票），
-- 按存檔之後跳出：
--
--     儲存失敗：會計不得核可請款單
--
-- 她根本沒在核可 —— 所以那句話跟她做的事對不起來，
-- 回報回來就變成「編輯沒有用」。查了很久才找到。
--
--
-- ============================================================
-- 【為什麼會這樣】
--
-- 前端在「改已送審的單」時，會把四個核可欄位一起清成 null
-- （purchases/page.tsx 的 header：manager_approved_* / admin_approved_*）。
--
-- 而 pr_guard_votes 這支 BEFORE 觸發器規定：
--
--     if r = 'accountant' and (
--          new.manager_approved_at is distinct from old.manager_approved_at or
--          new.admin_approved_at   is distinct from old.admin_approved_at)
--     then raise exception '會計不得核可請款單';
--
-- 對它來說「11:12 → null」就是動到核可欄位，不管動的方向是加票還是清票。
--
-- ★ **那個守衛是對的，不要放寬它。**
--   它擋的是「會計自己蓋章放行」——那是這套兩票制存在的理由。
--   為了讓編輯能通過而開一個「清成 null 可以」的例外，
--   等於留了一條「先清票再蓋章」的路。
--
--
-- ============================================================
-- 【所以要改的是前端不該碰那四欄】
--
-- 清票是**狀態轉換的後果**，不是使用者填的資料。
-- pr_apply_status 對「駁回」早就是這樣做的：
--
--     if new.status = 'rejected' and old.status is distinct from 'rejected' then
--       new.manager_approved_by := null; ... 清掉
--
-- 少的只是「退回草稿」這一條。補上之後：
--
--   · 前端只送 status = 'draft'，一個核可欄位都不碰
--   · 觸發器是 SECURITY DEFINER，清票時不受 pr_guard_votes 的角色限制
--     （守衛看的是「誰改的」，而這裡改的是系統本身）
--   · 安全性沒有變鬆：票還是被清了，而且是**一定**會被清 ——
--     前端漏送那四欄就繞過清票的路，反而是原本才有的
--
-- 前端那段同步移除（同一個 commit），不然會變成兩個地方都在清。


-- ── 擴充 pr_apply_status ───────────────────────────
/*
 * 只加一段「退回草稿也清票」，其餘一個字都不動。
 *
 * 位置在「駁回」後面、「送出」前面 —— 順序有意義:
 * 送出那一段會判斷免核門檻,如果先跑它,一筆從 pending 改回 draft 的單
 * 會在同一次 UPDATE 裡又被判成 approved。
 */
create or replace function public.pr_apply_status()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare threshold numeric := 3000;
begin
  -- 駁回:清掉既有票數,退回申請人
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    new.manager_approved_by := null; new.manager_approved_at := null;
    new.admin_approved_by   := null; new.admin_approved_at   := null;
    new.rejected_at := coalesce(new.rejected_at, now());
    return new;
  end if;

  /*
   * ★ 退回草稿也要清票（migration_149）。
   *
   * 內容改了就等於重來一次，既有的票不算數 ——
   * 不清的話「核可後改收款帳號」就能把錢導到別的地方，兩票白審。
   *
   * 由這裡清而不是前端清:前端清的話，會計會被 pr_guard_votes 擋下來
   * （對它來說清票也是「動到核可欄位」），而錯誤訊息是
   * 「會計不得核可請款單」—— 跟使用者正在做的事完全對不起來。
   */
  if new.status = 'draft' and old.status in ('pending', 'approved') then
    new.manager_approved_by := null; new.manager_approved_at := null;
    new.admin_approved_by   := null; new.admin_approved_at   := null;
    new.submitted_at := null;
    return new;
  end if;

  -- 送出(draft/rejected → pending)
  if new.status = 'pending' and old.status in ('draft','rejected') then
    new.submitted_at  := now();
    new.rejected_by   := null; new.rejected_at := null; new.reject_reason := null;
    if new.total_amount < threshold then
      new.status := 'approved';           -- 免核,直接放行
      return new;
    end if;
  end if;

  -- 兩票到齊 → 核可完成
  if new.status = 'pending'
     and new.manager_approved_at is not null
     and new.admin_approved_at   is not null then
    new.status := 'approved';
  end if;
  return new;
end $function$;

comment on function public.pr_apply_status() is
  '請款單狀態機。駁回與退回草稿都由這裡清票 —— '
  '前端清的話會被 pr_guard_votes 擋下（對它來說清票也算動核可欄位），'
  '而訊息是「會計不得核可請款單」，跟使用者做的事對不起來（migration_149）。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('149_pr_clear_votes_on_draft');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; src text;
begin
  drop table if exists _chk149;
  create temp table _chk149 (ord int, item text, result text, detail text);

  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'pr_apply_status';

  insert into _chk149 values (1, '退回草稿會清票',
    case when src like '%old.status in (''pending'', ''approved'')%' then '✅' else '❌' end,
    'new.status = draft 且原本是 pending/approved');

  /*
   * ★★ 既有的三段一個都不能掉。
   *
   * 這支是整個請款流程的狀態機。少一段的症狀都是「某種單卡住」，
   * 而且要等到有人真的走到那一步才會發現。
   */
  insert into _chk149 values (2, '★★ 駁回清票還在',
    case when src like '%new.status = ''rejected''%' then '✅' else '❌ 掉了' end, '');
  insert into _chk149 values (3, '★★ 免核門檻還在',
    case when src like '%threshold%' and src like '%new.status := ''approved''%'
         then '✅ 3000' else '❌ 掉了' end, '未達門檻自動核可');
  insert into _chk149 values (4, '★★ 兩票到齊翻 approved 還在',
    case when src like '%manager_approved_at is not null%' then '✅' else '❌ 掉了' end, '');

  /*
   * ★ 守衛不動。它擋的是「會計自己蓋章放行」——
   *   那是兩票制存在的理由，不能為了讓編輯過關而放寬。
   */
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'pr_guard_votes';
  insert into _chk149 values (5, '★ pr_guard_votes 沒被動到',
    case when src like '%會計不得核可請款單%' then '✅ 原樣' else '❌ 被改了' end,
    '這支不能放寬 —— 放寬就等於留了「先清票再蓋章」的路');

  select count(*) into n from public.purchase_requests
   where status = 'pending' and (manager_approved_at is not null or admin_approved_at is not null);
  insert into _chk149 values (6, '目前有票的待審單', n || ' 張',
    '這些單被編輯時會走到新加的那一段');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk149 order by ord;
