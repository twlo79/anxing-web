/* ══════════════════════════════════════════════════════════════════════
 * 一次性：建兩張請款單草稿 —— 住宅火災及地震保險 A棟（24 間）、B棟（48 間）   2026-09-24
 *
 * 來源：David 給的兩份試算表（A棟_火災地震保險.xlsx、B棟_火災地震保險.xlsx）
 *   A棟 24 列合計 103,704；B棟 48 列合計 182,883。
 *
 * 【建成什麼】status = draft（草稿）。憑證圖、付款方式、廠商帳戶這些
 *   SQL 填不了，開單子補完再按「送出審核」。
 *   · 申請人 ＝ acc@gmail.com 那個帳號
 *   · 每一列一個項目：項目名稱「住宅火災及地震保險 A棟」、會計科目 保險費（insurance）、
 *     用途 正隆、備註「3A1 - 火險 3107 +地震險1350」、金額。
 *   · 房源：照備註開頭的房號去 properties 找（正隆底下、名字或別名相同）；
 *     找不到的留空 —— 自檢第 3 列會列出哪幾間沒對到，你在畫面上補選就好。
 *
 * 【重跑】同一張單只建一次：找得到同名備註的草稿就跳過（自檢會說「已存在」）。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

create temp table _src (bldg text, sort int, room text, note text, amount numeric);
insert into _src values
  ('A', 1, '3A1', '3A1 - 火險 3107 +地震險1350', 4457),
  ('A', 2, '3A2', '3A2 - 火險 3209 +地震險1350', 4559),
  ('A', 3, '3A3', '3A3 - 火險 2678 +地震險1350', 4028),
  ('A', 4, '3A5', '3A5 - 火險 3052 +地震險1350', 4402),
  ('A', 5, '7A2', '7A2 - 火險 3254 +地震險1350', 4604),
  ('A', 6, '7A3', '7A3 - 火險 2641 +地震險1350', 3991),
  ('A', 7, '7A5', '7A5 - 火險 3064 +地震險1350', 4414),
  ('A', 8, '8A2', '8A2 - 火險 3254 +地震險1350', 4604),
  ('A', 9, '8A3', '8A3 - 火險 2698 +地震險1350', 4048),
  ('A', 10, '8A5', '8A5 - 火險 3064 +地震險1350', 4414),
  ('A', 11, '9A2', '9A2 - 火險 3197 +地震險1350', 4547),
  ('A', 12, '9A3', '9A3 - 火險 2641 +地震險1350', 3991),
  ('A', 13, '9A5', '9A5 - 火險 3007 +地震險1350', 4357),
  ('A', 14, '10A2', '10A2 - 火險 3254 +地震險1350', 4604),
  ('A', 15, '10A3', '10A3 - 火險 2698 +地震險1350', 4048),
  ('A', 16, '10A5', '10A5 - 火險 3064 +地震險1350', 4414),
  ('A', 17, '11A2', '11A2 - 火險 3197 +地震險1350', 4547),
  ('A', 18, '11A3', '11A3 - 火險 2587 +地震險1350', 3937),
  ('A', 19, '12A3', '12A3 - 火險 2587 +地震險1350', 3937),
  ('A', 20, '13A2', '13A2 - 火險 3197 +地震險1350', 4547),
  ('A', 21, '13A3', '13A3 - 火險 2587 +地震險1350', 3937),
  ('A', 22, '13A5', '13A5 - 火險 3006 +地震險1350', 4356),
  ('A', 23, '14A2', '14A2 - 火險 3254 +地震險1350', 4604),
  ('A', 24, '14A3', '14A3 - 火險 3007 +地震險1350', 4357),
  ('B', 1, '2B10', '2B10 - 火險 986 +地震險1350', 2336),
  ('B', 2, '3B1', '3B1 - 火險 2599 +地震險1350', 3949),
  ('B', 3, '3B2', '3B2 - 火險 2670 +地震險1350', 4020),
  ('B', 4, '3B3', '3B3 - 火險 2365 +地震險1350', 3715),
  ('B', 5, '3B5', '3B5 - 火險 2422 +地震險1350', 3772),
  ('B', 6, '4B1', '4B1 - 火險 2577 +地震險1350', 3927),
  ('B', 7, '4B2', '4B2 - 火險 2647 +地震險1350', 3997),
  ('B', 8, '4B3', '4B3 - 火險 2350 +地震險1350', 3700),
  ('B', 9, '4B5', '4B5 - 火險 2407 +地震險1350', 3757),
  ('B', 10, '5B1', '5B1 - 火險 2577 +地震險1350', 3927),
  ('B', 11, '5B2', '5B2 - 火險 2647 +地震險1350', 3997),
  ('B', 12, '5B3', '5B3 - 火險 2350 +地震險1350', 3700),
  ('B', 13, '5B5', '5B5 - 火險 2350 +地震險1350', 3700),
  ('B', 14, '6B1', '6B1 - 火險 2598 +地震險1350', 3948),
  ('B', 15, '6B2', '6B2 - 火險 2669 +地震險1350', 4019),
  ('B', 16, '6B3', '6B3 - 火險 2371 +地震險1350', 3721),
  ('B', 17, '6B5', '6B5 - 火險 2371 +地震險1350', 3721),
  ('B', 18, '7B1', '7B1 - 火險 2655 +地震險1350', 4005),
  ('B', 19, '7B2', '7B2 - 火險 2669 +地震險1350', 4019),
  ('B', 20, '7B3', '7B3 - 火險 2371 +地震險1350', 3721),
  ('B', 21, '7B5', '7B5 - 火險 2429 +地震險1350', 3779),
  ('B', 22, '9B3', '9B3 - 火險 2371 +地震險1350', 3721),
  ('B', 23, '11B5', '11B5 - 火險 2429 +地震險1350', 3779),
  ('B', 24, '12B3', '12B3 - 火險 2371 +地震險1350', 3721),
  ('B', 25, '12B5', '12B5 - 火險 2371 +地震險1350', 3721),
  ('B', 26, '13B1', '13B1 - 火險 2598 +地震險1350', 3948),
  ('B', 27, '13B2', '13B2 - 火險 2669 +地震險1350', 4019),
  ('B', 28, '13B3', '13B3 - 火險 2368 +地震險1350', 3718),
  ('B', 29, '14B1', '14B1 - 火險 2598 +地震險1350', 3948),
  ('B', 30, '14B2', '14B2 - 火險 2669 +地震險1350', 4019),
  ('B', 31, '14B3', '14B3 - 火險 2371 +地震險1350', 3721),
  ('B', 32, '14B5', '14B5 - 火險 2429 +地震險1350', 3779),
  ('B', 33, '15B1', '15B1 - 火險 2598 +地震險1350', 3948),
  ('B', 34, '15B2', '15B2 - 火險 2669 +地震險1350', 4019),
  ('B', 35, '15B3', '15B3 - 火險 2429 +地震險1350', 3779),
  ('B', 36, '15B5', '15B5 - 火險 2429 +地震險1350', 3779),
  ('B', 37, '16B1', '16B1 - 火險 2598 +地震險1350', 3948),
  ('B', 38, '16B2', '16B2 - 火險 2669 +地震險1350', 4019),
  ('B', 39, '16B3', '16B3 - 火險 2429 +地震險1350', 3779),
  ('B', 40, '16B5', '16B5 - 火險 2429 +地震險1350', 3779),
  ('B', 41, '17B1', '17B1 - 火險 2598 +地震險1350', 3948),
  ('B', 42, '17B2', '17B2 - 火險 2611 +地震險1350', 3961),
  ('B', 43, '17B3', '17B3 - 火險 2429 +地震險1350', 3779),
  ('B', 44, '17B5', '17B5 - 火險 2429 +地震險1350', 3779),
  ('B', 45, '18B2', '18B2 - 火險 2349 +地震險1350', 3699),
  ('B', 46, '18B3', '18B3 - 火險 2291 +地震險1350', 3641),
  ('B', 47, '19B2', '19B2 - 火險 2401 +地震險1350', 3751),
  ('B', 48, '19B3', '19B3 - 火險 2401 +地震險1350', 3751);

create temp table _made (bldg text, request_id uuid, req_no text, created boolean);

do $$
declare
  v_uid    uuid;
  v_estate uuid;
  v_code   text;
  b        text;
  rid      uuid;
  rno      text;
  v_note   text;
begin
  /* 申請人 ＝ 登入 email 是 acc@gmail.com 的那個帳號（David 指定，2026-09-24）。 */
  select u.id into v_uid from auth.users u where lower(u.email) = 'acc@gmail.com';
  if v_uid is null then raise exception '找不到申請人：auth.users 沒有 acc@gmail.com'; end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid) then
    raise exception 'acc@gmail.com 有帳號但 profiles 沒有這個人，請款單會掛不上申請人';
  end if;

  select id into v_estate from public.estates where name = '正隆' limit 1;
  if v_estate is null then raise exception '找不到物業「正隆」'; end if;

  select code into v_code from public.account_codes where code = 'insurance' and active limit 1;
  if v_code is null then
    select code into v_code from public.account_codes where name = '保險費' and active order by sort limit 1;
  end if;
  -- 科目找不到就留空，畫面上再選；不擋

  foreach b in array array['A', 'B'] loop
    v_note := '住宅火災及地震保險 ' || b || '棟（2026-09-24 由試算表匯入）';

    select id, req_no into rid, rno from public.purchase_requests
     where requester_id = v_uid and status = 'draft' and note = v_note limit 1;
    if rid is not null then
      insert into _made values (b, rid, rno, false);
      continue;
    end if;

    rno := public.next_req_no();
    insert into public.purchase_requests (req_no, requester_id, status, note, currency, fx_rate)
    values (rno, v_uid, 'draft', v_note, 'TWD', 1)
    returning id into rid;

    insert into public.purchase_request_items
      (request_id, item_name, amount, amount_original, account_code, purpose_type, estate_id, property_id, note, sort)
    select rid, '住宅火災及地震保險 ' || b || '棟', s.amount, s.amount, v_code, 'estate', v_estate,
           (select p.id from public.properties p
             where p.estate_id = v_estate
               and (p.name = s.room or s.room = any(coalesce(p.name_aliases, '{}')))
             limit 1),
           s.note, s.sort
      from _src s where s.bldg = b order by s.sort;

    insert into _made values (b, rid, rno, true);
  end loop;
end $$;

commit;

-- 自檢（在 commit 後面 —— 看不到就是整支回滾了）
select 1 as 序, '建了哪兩張（單號 · 項目數 · 總額）' as 檢查,
       (select string_agg(m.bldg || '棟 ' || m.req_no || ' · ' ||
               (select count(*) from public.purchase_request_items i where i.request_id = m.request_id) || ' 項 · $' ||
               (select total_amount from public.purchase_requests r where r.id = m.request_id)::text ||
               case when m.created then '' else '（已存在，沒重建）' end, '　｜　' order by m.bldg) from _made m) as 結果,
       case when (select count(*) from _made where created) = 2 then '✅ 兩張都是這次建的'
            when (select count(*) from _made where created) = 0 then 'ℹ 兩張早就有了，這次沒動'
            else '⚠ 只建了一張，另一張本來就在' end as 判定
union all select 2, '總額對不對（A 103,704／B 182,883）',
       (select string_agg(m.bldg || ' ' || r.total_amount::text, '／' order by m.bldg) from _made m join public.purchase_requests r on r.id = m.request_id),
       case when (select bool_and(r.total_amount = case m.bldg when 'A' then 103704 else 182883 end)
                    from _made m join public.purchase_requests r on r.id = m.request_id)
            then '✅' else '❌ 跟試算表對不上，貼給我' end
union all select 3, '房源沒對到的項目（畫面上補選）',
       coalesce((select string_agg(split_part(i.note, ' - ', 1), '、' order by m.bldg, i.sort)
                   from _made m join public.purchase_request_items i on i.request_id = m.request_id
                  where i.property_id is null), '（全部對到）'),
       case when exists (select 1 from _made m join public.purchase_request_items i on i.request_id = m.request_id where i.property_id is null)
            then 'ℹ 這幾間 properties 裡沒有同名的，開單子時手動選' else '✅' end
union all select 4, '會計科目',
       coalesce((select i.account_code from _made m join public.purchase_request_items i on i.request_id = m.request_id limit 1), '（空，畫面上選）'),
       case when (select i.account_code from _made m join public.purchase_request_items i on i.request_id = m.request_id limit 1) is not null then '✅ 保險費' else 'ℹ 沒找到「保險費」科目，開單子時選' end
order by 1;
