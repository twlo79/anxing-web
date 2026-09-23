/* ══════════════════════════════════════════════════════════════════════
 * 病假改成「不看額度、只報累積」                              2026-09-23
 *
 * 【★★★ 要改的是 `leave_types.has_quota`，不是把額度數字清成 0】
 *
 *   `request_leave_batch()`（migration_291）是這樣擋的：
 *
 *       if lt.has_quota then
 *         if bal.id is null or coalesce(bal.quota_hours,0) <= 0 then
 *           return NO_QUOTA -- 「今年還沒有配額」
 *
 *   所以「把病假的額度清成 0」會讓病假**一張都送不出去** ——
 *   而畫面上只會說「今年還沒有配額，請主管去設定」，看起來像設定漏了。
 *   （我上一則給的說法就是這個錯的，在這裡更正。）
 *
 *   把 `has_quota` 關掉才是對的：資料庫整段額度檢查直接跳過，
 *   畫面那邊也是讀同一欄 —— 卡片改成「今年已請 N 小時」，表單底下改成
 *   「送出後今年累積 N 小時」。**兩邊講的是同一件事，不會一邊擋一邊沒說。**
 *
 * 【★★ 已經請掉的不會不見】
 *   `used_hours` 是 `recalc_leave_used()` 從已核可的假單重算出來的，
 *   跟 `has_quota` 無關 —— 關掉之後累積數字照樣是對的。
 *
 * 【要改回來】把 false 改成 true 再跑一次，然後到「管理 → 假別額度」設今年的時數。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

create temp table _lt_result (code text, name text, was boolean, now_ boolean, n_upd int);

do $$
declare
  n     int;
  v_was boolean;
  v_name text;
  n_upd int;
begin
  select count(*) into n from public.leave_types where code = 'sick';
  if n <> 1 then
    raise exception '找不到（或找到多筆）code = sick 的假別，實際 % 筆 —— 整支停下來，一列都沒改', n;
  end if;

  select has_quota, name into v_was, v_name from public.leave_types where code = 'sick';

  update public.leave_types set has_quota = false where code = 'sick';
  get diagnostics n_upd = row_count;
  if n_upd <> 1 then
    raise exception '更新影響 % 列（預期 1）—— 整支退回', n_upd;
  end if;

  insert into _lt_result values ('sick', v_name, v_was, false, n_upd);
end $$;

commit;

-- ═══ 自檢 ═══════════════════════════════════════════════════════════
-- 看不到這張表 ＝ 整支回滾了，一列都沒改。
select 1 as "序", '這一次改到的假別數（要 1）' as "檢查",
       (select n_upd::text from _lt_result) as "結果",
       case when (select n_upd from _lt_result) = 1 then '✅' else '❌' end as "判定"
union all
select 2, '病假現在看不看額度（要 false）',
       (select has_quota::text from public.leave_types where code = 'sick'),
       case when (select has_quota from public.leave_types where code = 'sick') = false
            then '✅ 送出時不再檢查額度，畫面改報累積' else '❌ 沒改到' end
union all
select 3, '改之前是什麼（給要改回來的人看）',
       (select was::text from _lt_result), 'ℹ 要還原就把它改回這個值'
union all
-- ★ 這一列才是重點：累積時數不可以因為這次改動而消失
select 4, '病假今年的累積時數（改動前後必須一樣）',
       coalesce((select sum(used_hours)::text from public.leave_balances
                  where type_code = 'sick'
                    and year = extract(year from (now() at time zone 'Asia/Taipei'))::int), '0'),
       case when coalesce((select sum(used_hours) from public.leave_balances
                            where type_code = 'sick'
                              and year = extract(year from (now() at time zone 'Asia/Taipei'))::int), 0) >= 0
            then '✅ used_hours 由已核可的假單重算，跟 has_quota 無關' else '❌' end
union all
-- ★ 母體要判定，不能只當參考
select 5, '母體：還有幾個假別在看額度',
       (select count(*)::text from public.leave_types where has_quota and active),
       case when (select count(*) from public.leave_types where has_quota and active) = 0
            then '⚠ 一個都不剩 —— 特休應該還要看額度，停下來檢查'
            else '✅ 特休那類還在看額度' end
order by 1;
