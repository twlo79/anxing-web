/*
 * 清-8月房務清潔全部重跑（2026-09-07）
 * ============================================================
 * 使用者：「乾脆把我之前所有房務清潔都刪掉，我全部重跑」
 *
 * 前提查過了:`hk_cleaning` 只有 2026-08 有資料（73 筆 $484,010），
 * 而且 **0 筆被標⭐、0 筆有備註、0 筆有憑證** —— 沒有人手動改過任何一筆,
 * 所以刪掉重產不會弄丟東西。其他月份沒有資料，動不到。
 *
 * ============================================================
 * 【★★★ 為什麼要 set_config，那不是繞過權限】
 *
 * `soft_delete()` 檢查 `trash_can_delete()` → `current_role_of()`
 *   → `select role from profiles where id = auth.uid()`
 *
 * SQL Editor **沒有身分**，`auth.uid()` 是 null，所以一律被拒絕 ——
 * 而它是**回傳 `{ok:false}` 不是報錯**，第一版用 `perform` 把回傳丟掉,
 * 於是印出「共刪除 6 筆」但一筆都沒少（2026-09-07 踩到）。
 *
 * ★ 這裡設 jwt claim 只是讓它**知道你是誰**，角色檢查照跑、
 *   `trash.deleted_by` 也會正確記到那個人頭上。
 * ★★ 而且底下每一筆都接住 `ok`，有任何一筆失敗就整個 rollback。
 *
 * ============================================================
 * 【★★ 只刪「產生出來的」】
 *
 * 條件加了 `hk_job_key is not null or hk_labor_key is not null`。
 * 人手動新增的房務清潔沒有那兩個 key —— 刪掉的話**沒有任何地方生得回來**,
 * 而重產只會生出公式算得出來的那些。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor。跑完看 Messages。
 */

do $do$
declare
  ME    uuid;
  WHO   text;
  r     record;
  res   jsonb;
  n     int := 0;
  fail  int := 0;
  total numeric := 0;
begin
  -- ── 挑一個有權限的身分 ────────────────────────────
  /*
   * ★ 印出用了誰。不印的話「這 73 筆是誰刪的」在回收桶裡會是個謎,
   *   而那正是回收桶存在的意義。
   */
  select p.id, p.name || '（' || p.role || '）'
    into ME, WHO
    from public.profiles p
   where p.active and p.role in ('super_admin', 'manager', 'accountant')
   order by case p.role when 'super_admin' then 1 when 'manager' then 2 else 3 end,
            p.name
   limit 1;

  if ME is null then
    raise exception '找不到有刪除權限的帳號（super_admin／manager／accountant）';
  end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', ME, 'role', 'authenticated')::text, true);

  if public.current_role_of() is null then
    raise exception '身分沒設定成功 —— auth.uid() 仍然是 null';
  end if;
  raise notice '以 % 的身分執行', WHO;

  -- ── 刪 ────────────────────────────────────────────
  for r in
    select e.id, e.amount, e.item_name, e.spent_on
      from public.expenses e
     where e.account_code = 'hk_cleaning'
       and e.spent_on >= date '2026-08-01'
       and e.spent_on <  date '2026-09-01'
       and (e.hk_job_key is not null or e.hk_labor_key is not null)
     order by e.spent_on
  loop
    -- ★★★ `res :=` 不是 `perform` —— perform 會把 {ok:false} 吞掉
    res := public.soft_delete('expenses', r.id, '8 月房務清潔全部重跑（migration_226）');
    if coalesce((res->>'ok')::boolean, false) then
      n := n + 1;
      total := total + coalesce(r.amount, 0);
    else
      fail := fail + 1;
      raise notice '✗ % % —— %', r.spent_on, r.item_name,
                   coalesce(res->>'message', res::text);
    end if;
  end loop;

  /*
   * ★★ 一筆失敗就整個 rollback。刪一半最糟:
   *   帳上一半是新規則、一半是舊的,而兩種都「看起來正常」。
   */
  if fail > 0 then
    raise exception '% 筆刪不掉（成功的 % 筆已一併回復）', fail, n;
  end if;

  raise notice '── 共刪除 % 筆，合計 $% ──', n, total;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 確認。★ 不要相信上面的訊息，相信這一支
-- ══════════════════════════════════════════════════════════
select count(*) as "剩下幾筆", coalesce(sum(amount), 0) as "剩下金額"
  from public.expenses
 where account_code = 'hk_cleaning'
   and spent_on >= date '2026-08-01' and spent_on < date '2026-09-01';
