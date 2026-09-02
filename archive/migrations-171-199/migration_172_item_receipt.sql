-- migration_172：請款項目的憑證圖片（逐項上傳）
--
-- ============================================================
-- 【為什麼】（2026-08-24 使用者指定）
--
-- 「單項可上傳憑證。開共用憑證後關掉，反之一樣。」
--
-- 憑證**號碼**從 migration_155 就有兩層了:勾共同憑證用單頭那一個，
-- 沒勾則每個項目各自填。但**圖片一直只有請款單一層**。
--
-- 一張單十七個項目、十七張不同的發票時，圖只能全部堆在單頭，
-- 而審核的人看不出哪張對哪一項。
--
--
-- ============================================================
-- 【前置條件:前端的存檔邏輯必須先改成 upsert】
--
-- 原本每次存檔是**全刪再全寫**:
--
--     delete from purchase_request_items where request_id = …;
--     insert into purchase_request_items (…) values (…);
--
-- 所以項目的 id 每存一次就換一批新的。圖掛在 request_item_id 上的話:
--
--   · on delete cascade   → 每按一次存檔，剛傳的發票**全部被刪掉**
--   · on delete set null  → 沒有母層的孤兒，違反 att_one_parent
--
-- 而使用者按存檔的時機，正好是他剛傳完發票的時候。
--
-- 前端已改（src/lib/pr-items-save.ts，13 個測試）:有 id 就 update、
-- 沒有才 insert、畫面上移除的才 delete。
--
-- ★ 這也順手修掉一個既有隱患:`expenses.source_item_id` 也指向這些 id，
--   一直沒出事只是因為「出款後不能編輯」讓 id 沒機會再變。
--   那是僥倖，不是設計。
--
--
-- ============================================================
-- 【路徑前綴用 `pri/`】
--
-- 路徑格式是 `<kind>/<母層id>/<uuid>.<副檔名>`（見 Receipts.tsx）。
--
--   pr   請款單（單頭，共同憑證）
--   pri  請款項目  ← 這支新增
--
-- ★ 不能用 `pr/` 加上不同的第二段就算了 ——
--   can_see_receipt 是用 `like 'pr/%'` 判斷的，
--   而 `pri/…` 也符合 `pr/%` 嗎?**不符合**（`pr/` 要求第三個字是斜線，
--   而 pri 的第三個字是 i）。兩者分得開，這是刻意挑的。
--
--
-- ============================================================
-- 【互斥寫在畫面，不寫在資料庫】
--
-- 「開共用憑證後關掉，反之一樣」—— 這是**畫面的規則**，不是資料的規則。
--
-- 資料庫不擋的理由:使用者可能先傳了逐項的圖、才發現其實只有一張發票，
-- 於是改勾共同憑證。這時候逐項那些圖要**留著**（跟號碼一樣「留著但不使用」，
-- 2026-08-22 使用者指定）—— 取消勾選就回來了。
--
-- 資料庫擋的話，那些圖會在勾選的當下被刪掉，而使用者不會知道
-- 是自己勾那一下弄掉的。這個專案的錯誤幾乎都是這樣發生的。
-- ============================================================


-- ============================================================
-- ① 第七個母層
-- ============================================================
alter table public.attachments
  add column if not exists request_item_id uuid
    references public.purchase_request_items(id) on delete cascade;

create index if not exists att_req_item_idx on public.attachments (request_item_id);

comment on column public.attachments.request_item_id is
  '請款項目的憑證圖（路徑前綴 pri/）。刪項目時一起刪 —— '
  '項目沒了，掛在它底下的發票留著也沒有意義（migration_172）。';


-- ============================================================
-- ② att_one_parent：七選一
-- ============================================================
/*
 * ★ 用動態 SQL 從 information_schema 撈**實際存在**的欄位，
 *   不要寫死清單 —— 寫死的話下一個人加第八個母層時這裡會安靜地漏掉，
 *   而症狀是「某一種憑證存不進去」。
 *   （做法沿用 migration_158，但那支因為註解壞掉沒跑成功，見 README 9.1⑥。）
 *
 * ★ table_schema = 'public' 不能少 —— attachments 這種名字
 *   在其他 schema 也有（CLAUDE.md 記載的坑）。
 */
do $$
declare
  cols text;
  expr text;
begin
  select string_agg(quote_ident(column_name), ', ' order by column_name)
    into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'attachments'
     and column_name in ('request_id', 'expense_id', 'deposit_id',
                         'order_payment_id', 'deposit_payment_id', 'order_id',
                         'request_item_id');

  select string_agg('(' || quote_ident(column_name) || ' is not null)::int', ' + '
                    order by column_name)
    into expr
    from information_schema.columns
   where table_schema = 'public' and table_name = 'attachments'
     and column_name in ('request_id', 'expense_id', 'deposit_id',
                         'order_payment_id', 'deposit_payment_id', 'order_id',
                         'request_item_id');

  alter table public.attachments drop constraint if exists att_one_parent;
  execute format('alter table public.attachments add constraint att_one_parent check ((%s) = 1)', expr);
end $$;


-- ============================================================
-- ③ 看與改的權限
-- ============================================================
/*
 * 逐項憑證跟單頭憑證是**同一張單上的東西**，權限應該一樣:
 *
 *   · 會計以上   全部看得到（第一行）
 *   · 管家       看得到（migration_171 已對 pr/ 開放，這裡比照）
 *   · 其他人     只看得到自己送的單底下的
 *
 * ★ 最後那條 else 要多一段 join ——
 *   `pri/` 的附件掛的是 request_item_id，不是 request_id，
 *   原本那個 `join purchase_requests p on p.id = a.request_id` 對不到，
 *   會**安靜地回 false**。沒有錯誤訊息，照片就是不見
 *   （migration_154 的註解記過同一種症狀）。
 */
create or replace function public.can_see_receipt(p_path text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select case
    when current_role_of() in ('accountant','manager','super_admin') then true
    -- 管家:訂單的收款證明（migration_154）
    when current_role_of() = 'housekeeper' and p_path like 'op/%' then true
    -- 管家:訂單加費的憑證（migration_158 的 of 前綴）
    when current_role_of() = 'housekeeper' and p_path like 'of/%' then true
    -- 管家:請款單單頭的憑證圖（migration_171）
    when current_role_of() = 'housekeeper' and p_path like 'pr/%' then true
    -- 管家:請款項目的憑證圖（migration_172）
    when current_role_of() = 'housekeeper' and p_path like 'pri/%' then true
    -- 其他人只看得到自己送的請款單底下的附件（單頭與項目都算）
    else exists (
      select 1
      from public.attachments a
      left join public.purchase_requests p1 on p1.id = a.request_id
      left join public.purchase_request_items pi on pi.id = a.request_item_id
      left join public.purchase_requests p2 on p2.id = pi.request_id
      where a.path = p_path
        and coalesce(p1.requester_id, p2.requester_id) = auth.uid()
    )
  end;
$function$;

comment on function public.can_see_receipt(text) is
  '誰看得到這個路徑的憑證。會計以上全部；管家看得到 op/、of/、pr/、pri/；'
  '其他人只看得到自己送的請款單底下的（單頭 pr/ 與項目 pri/ 都算，migration_172）。';


/*
 * can_edit_receipt:**只加自己送的單的項目**，不給管家 pri/。
 *
 * ★ 跟 migration_171 同一條原則:看錯一張圖沒有後果，
 *   刪掉一張別人的發票有 —— 而且刪掉之後只會少一張圖，
 *   沒有任何紀錄說是誰刪的。
 *
 * ★ 狀態限制沿用單頭那條:只有 draft / rejected / pending 能改。
 *   已核可或已出款的單，發票不能再動。
 */
create or replace function public.can_edit_receipt(p_path text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select case
    when current_role_of() in ('accountant','manager','super_admin') then true
    when current_role_of() = 'housekeeper' and p_path like 'op/%' then true
    when current_role_of() = 'housekeeper' and p_path like 'of/%' then true
    else exists (
      select 1
      from public.attachments a
      left join public.purchase_requests p1 on p1.id = a.request_id
      left join public.purchase_request_items pi on pi.id = a.request_item_id
      left join public.purchase_requests p2 on p2.id = pi.request_id
      where a.path = p_path
        and coalesce(p1.requester_id, p2.requester_id) = auth.uid()
        and coalesce(p1.status, p2.status) in ('draft','rejected','pending')
    )
  end;
$function$;

comment on function public.can_edit_receipt(text) is
  '誰改得動這個路徑的憑證。會計以上全部；管家只有 op/ 與 of/（訂單相關）；'
  '其他人只能改自己送的、且還沒核可的單底下的（migration_172）。'
  '★ 管家看得到 pr/ 與 pri/ 但改不動 —— 看與改刻意分開。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('172_item_receipt');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
create temp table _chk172 (ord int, item text, result text, note text) on commit drop;

/*
 * ★★ 真的存一張 pri/ 的附件進去再回滾。
 *
 *   只檢查「欄位在不在」抓不到 att_one_parent 沒重建 ——
 *   那個約束會讓 insert 失敗，而症狀是使用者按上傳沒反應。
 */
do $$
declare v_item uuid; v_msg text;
begin
  select id into v_item from public.purchase_request_items limit 1;
  if v_item is null then
    insert into _chk172 values (1, '★★ 逐項憑證存得進去', '⚠ 測不出來', '一個請款項目都沒有');
    return;
  end if;

  begin
    insert into public.attachments (path, file_name, request_item_id)
    values ('pri/' || v_item::text || '/__172測試__.jpg', '__172測試__.jpg', v_item);
    v_msg := '✅ 存得進去';
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    -- 抓 others 不抓單一種類:att_one_parent 丟的是 check_violation，
    -- 只抓一種的話會炸掉整份腳本（README 9.4 第 9 條）
    if sqlerrm <> '__rollback__' then v_msg := '❌ ' || sqlerrm; end if;
  end;

  insert into _chk172 values (1, '★★ 逐項憑證存得進去', coalesce(v_msg, '⚠ 沒跑到'),
    'att_one_parent 有沒有重建成七選一');
end $$;

/*
 * ★★ 兩個母層同時填 —— 必須被擋下來。
 *   擋不住的話會出現「一張圖同時屬於單頭與某一項」，
 *   而刪任何一邊都刪不乾淨。
 */
do $$
declare v_item uuid; v_req uuid; v_msg text;
begin
  select pi.id, pi.request_id into v_item, v_req
    from public.purchase_request_items pi limit 1;
  if v_item is null then
    insert into _chk172 values (2, '★★ 兩個母層要被擋', '⚠ 測不出來', '');
    return;
  end if;

  begin
    insert into public.attachments (path, file_name, request_item_id, request_id)
    values ('pri/x/__172測試2__.jpg', '__172測試2__.jpg', v_item, v_req);
    v_msg := '❌ 沒擋住 —— att_one_parent 壞了';
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when check_violation then
    v_msg := '✅ 擋下來了';
  when others then
    if sqlerrm <> '__rollback__' then v_msg := '⚠ ' || sqlerrm; end if;
  end;

  insert into _chk172 values (2, '★★ 兩個母層同時填要被擋', coalesce(v_msg, '⚠ 沒跑到'),
    '一張圖只能有一個母層');
end $$;


select "檢查項目", "結果", "說明" from (

  select c.ord, c.item as "檢查項目", c.result as "結果", c.note as "說明"
    from _chk172 c

  union all
  select 3, '★ att_one_parent 現在涵蓋幾個母層',
         (select count(*)::text || ' 個'
            from information_schema.columns
           where table_schema = 'public' and table_name = 'attachments'
             and column_name in ('request_id','expense_id','deposit_id',
                                 'order_payment_id','deposit_payment_id',
                                 'order_id','request_item_id')),
         '應為 7 個。是 6 的話表示 migration_158 的 order_id 還沒建'

  union all
  /*
   * ★★ 管家看得到 pri/ 但改不動。看與改要分開。
   */
  select 4, '★★ 管家:看得到 pri/、改不動',
         case when pg_get_functiondef('public.can_see_receipt(text)'::regprocedure)
                   like '%housekeeper%pri/%'
              and pg_get_functiondef('public.can_edit_receipt(text)'::regprocedure)
                  not like '%housekeeper%pri/%'
              then '✅' else '❌ 兩支不一致' end,
         '刪掉別人的發票沒有紀錄說是誰刪的'

  union all
  /*
   * ★ else 分支要認得 request_item_id。
   *   漏了的話「自己送的單」的逐項憑證會安靜地看不到。
   */
  select 5, '★ else 分支認得項目層',
         case when pg_get_functiondef('public.can_see_receipt(text)'::regprocedure)
                   like '%request_item_id%' then '✅' else '❌ 送單的人看不到自己的圖' end,
         'pri/ 掛的是 request_item_id,不是 request_id'

  union all
  select 6, '目前的逐項憑證', count(*)::text || ' 張',
         '這支只加欄位與規則,一個檔案都沒動'
    from public.attachments where request_item_id is not null

) v order by ord;
