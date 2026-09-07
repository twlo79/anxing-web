'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { isFilled, validateDemand, estateIdToSave } from '@/lib/demand';
import { useProfile } from '@/lib/profile';
import { ReqMark } from '@/components/Req';
import {
  demandProgress, progressText, demandClass, ITEM_STATUS_LABEL,
  manualStatusOptions, manualStatusPatch, manualStatusNote, isOrphanRequested,
  PURCHASE_PLATFORMS,
  type DemandItemStatus,
} from '@/lib/purchase-demand';
import {
  isTakeable, toRequestItems, linkBackPlan, canMarkDone, markDoneConfirm,
} from '@/lib/demand-to-request';
import { useRouter } from 'next/navigation';

/**
 * 採購需求（房務管理的第三個分頁）。
 *
 * ============================================================
 * 【提需求的人這一側】
 *
 * 這一頁回答兩個問題，其餘都是次要的:
 *
 *   1. 我要的東西買了沒？
 *   2. 還缺哪幾樣？
 *
 * **不需要有請款單的權限就答得出來** —— 狀態是從自己那張需求單上讀的，
 * 不是去請款頁查。房務連請款頁的選單都沒有,如果要看進度得跑去問會計，
 * 那這個功能就只是換一個地方填 Google 表單而已。
 *
 *
 * ============================================================
 * 【為什麼一張單可以有多個項目】
 *
 * 「這次要買的東西」本來就是一串。拆成五張單的話:
 *   · 填的人要按五次新增
 *   · 會計要看五張單才知道這批要買什麼
 *   · 而它們其實是同一次採購
 *
 * 項目列的操作照請款單的形狀（使用者指定「參考請款單設計」）。
 */

type Item = {
  id?: string;
  item_name: string;
  /** 規格說明。**大概數量寫在這裡**（migration_141 之後沒有數量欄） */
  spec: string;
  /**
   * 用途類別（migration_186）。
   *
   * ★★ `office` 時 `estate_id` **必須是空字串** ——
   *   安幸辦公室不是物業，它不在 `estates` 裡。
   *   資料庫有互斥約束擋著（`pdi_purpose_one_of`），
   *   前端留著上一次選的物業的話會被擋下來，而錯誤訊息看不懂。
   */
  purpose_type: 'estate' | 'office';
  estate_id: string;
  /** 建議採購連結（蝦皮／露天等）。知道去哪買時填,會計省一趟詢價 */
  buy_link: string;
  status: DemandItemStatus;
  request_item_id?: string | null;
  /*
   * 平台與兩個日期（migration_222）。三個都可以留空 ——
   * 必填的話人會亂填，而亂填的資料比空著更糟:
   * 空的看得出來沒填，填錯的看起來像真的。
   */
  /** 在哪買的。清單在 `PURCHASE_PLATFORMS`，畫面只給選不給打字 */
  platform?: string | null;
  /** 預計到貨。★ 已詢價時就填得了 —— 廠商講幾天到就先寫上去 */
  eta?: string | null;
  /** 東西哪一天買的。★ 跟請款單的出款日不同，零用金那條路沒有請款單 */
  purchased_on?: string | null;
  /** 這一項被哪張請款單領走。只在讀取時帶進來，存檔不寫 */
  request_no?: string | null;
};

type Demand = {
  id: string;
  demand_no: string | null;
  requester_id: string;
  requester_name?: string | null;
  requested_on: string;
  note: string | null;
  /** 寄送地點。物業名稱、「安幸辦公室」或「其他」—— 存文字,後兩個不是物業 */
  ship_to: string | null;
  ship_floor: string | null;
  status: 'open' | 'partial' | 'done' | 'cancelled';
  items: Item[];
};

/*
 * 寄送地點的額外選項。
 *
 * 物業清單從 estates 來，但這兩個不是物業 —— 所以 ship_to 存文字
 * 而不是 estate_id（見 migration_141 的註解）。
 */
const SHIP_EXTRA = ['安幸辦公室', '其他'];

const blankItem = (): Item =>
  ({ item_name: '', spec: '', purpose_type: 'estate', estate_id: '', buy_link: '', status: 'pending' });

const inp = 'rounded-lg border border-gray-300 px-2 py-1.5 text-sm';

export default function DemandTab({ onMsg }: { onMsg: (t: string, err?: boolean) => void }) {
  const supabase = useMemo(() => createClient(), []);
  const { profile } = useProfile();
  const role = profile?.role ?? '';
  /** 會計以上看得到全部；其餘只看得到自己提的（RLS 也擋，這裡只是不要白撈） */
  const seesAll = ['accountant', 'manager', 'super_admin'].includes(role);

  const [rows, setRows] = useState<Demand[]>([]);
  const [estates, setEstates] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<
    { note: string; ship_to: string; ship_floor: string; items: Item[] } | null>(null);
  const [saving, setSaving] = useState(false);

  /*
   * ══════════ 接到請款單（2026-09-05）══════════
   *
   * ★★★ 這條路本來就設計好了（migration_140 有關聯欄位、單頭彙總、
   *   已請款鎖住、駁回自動退回）—— **但前端從來沒有寫過 `requested`**。
   *   資料庫裡一共只有 1 筆項目、狀態 `pending`，證實它沒被走過。
   *
   * 兩條路:
   *   A 走請款單  勾項目 → 建草稿（金額留空）→ 詢價 → 填金額 → 送審
   *   B 直接買    勾項目 → 標為已採購（零用金，不產生請款單）
   */
  const router = useRouter();
  const [msg, setMsg] = useState('');
  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 4000); }
  /** 勾選的需求項目 id。★ 跨單勾選沒有意義 —— 一張請款單對一張需求單 */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState(false);

  const togglePick = (id: string) => setPicked((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  /** 這一張單被勾了幾項（勾選是全域的，畫面上要按單算） */
  const pickedIn = (d: Demand) => d.items.filter((i) => i.id && picked.has(i.id));

  /**
   * A · 建請款單（草稿，金額留空）。
   *
   * ★★★ 三段都要數影響列數 —— RLS 擋下的 INSERT／UPDATE
   *   **回成功且影響 0 列**（CLAUDE.md）。中間斷掉的話會變成
   *   「請款單建好了但需求單還顯示未採購」，而兩邊都不會叫。
   */
  async function makeRequest(d: Demand) {
    if (acting) return;
    const pick = pickedIn(d).filter((i) => isTakeable(i.status));
    if (!pick.length) return flash('先勾要進請款的項目');
    setActing(true);
    try {
      /*
       * ① 開一張草稿請款單。
       *
       * ★★★ `req_no` 是 `not null` 而且**沒有觸發器會填** ——
       *   要先呼叫 `next_req_no()` 這支 RPC 拿號碼。
       *   請款頁本來就是這樣做的（`purchases/page.tsx:1045`）——
       *   不照抄的話 insert 會被 not-null 擋下來。
       */
      const { data: no, error: ne } = await supabase.rpc('next_req_no');
      if (ne || !no) return flash('拿不到請款單號：' + (ne?.message ?? '沒有回傳'));

      const { data: pr, error: e1 } = await supabase.from('purchase_requests')
        .insert({
          req_no: no,
          requester_id: profile?.id ?? null,
          status: 'draft',
          note: `從採購需求 ${d.demand_no ?? ''} 帶入`.trim(),
        }).select('id, req_no').single();
      if (e1 || !pr) return flash('建不出請款單：' + (e1?.message ?? '沒有回傳'));

      // ② 帶項目進去。★ 金額是 null 不是 0（migration_218）
      const drafts = toRequestItems(pick as any);
      const { data: items, error: e2 } = await supabase.from('purchase_request_items')
        .insert(drafts.map((x) => ({
          request_id: pr.id, item_name: x.item_name, amount: x.amount,
          purpose_type: x.purpose_type, estate_id: x.estate_id,
          note: x.note, sort: x.sort,
        }))).select('id');
      if (e2) return flash('項目帶不進去：' + e2.message);
      if ((items?.length ?? 0) !== drafts.length) {
        return flash(`要帶 ${drafts.length} 項，實際只進去 ${items?.length ?? 0} 項 —— 先不要送審，找管理員`);
      }

      // ③ 回寫需求項目:狀態 → 已進請款、記住是哪一列請款項目
      const plan = linkBackPlan(drafts, (items ?? []).map((x: any) => x.id));
      let linked = 0;
      for (const p of plan) {
        const { data, error } = await supabase.from('purchase_demand_items')
          .update({ status: 'requested', request_item_id: p.requestItemId })
          .eq('id', p.demandItemId).select('id');
        if (error) { flash('回寫需求單失敗：' + error.message); break; }
        linked += data?.length ?? 0;
      }
      /*
       * ★★ 回寫少了要講。少了的那幾項會留在「未採購」，
       *   下次又被帶進另一張請款單 —— 同一筆錢請兩次。
       */
      if (linked !== plan.length) {
        flash(`請款單 ${pr.req_no ?? ''} 建好了，但只回寫了 ${linked}/${plan.length} 項 —— `
            + '沒回寫的那幾項還是「未採購」，不要再帶一次');
      }
      setPicked(new Set());
      await load();
      // ★ 直接跳過去填金額 —— 不跳的話使用者得自己找那張單，而它是草稿、排在最後
      router.push('/purchases');
    } finally { setActing(false); }
  }

  /**
   * B · 標為已採購（零用金直接買，不產生請款單）。
   *
   * ★ 已進請款的不給按 —— 那條路的完成要跟著請款單走
   *   （`canMarkDone` 擋，按鈕也不顯示）。
   */
  async function markDone(d: Demand) {
    if (acting) return;
    const pick = pickedIn(d).filter(canMarkDone);
    if (!pick.length) return flash('先勾要標記的項目');
    if (!confirm(markDoneConfirm(pick.map((i) => i.item_name)))) return;
    setActing(true);
    try {
      const ids = pick.map((i) => i.id!).filter(Boolean);
      const { data, error } = await supabase.from('purchase_demand_items')
        .update({ status: 'done' }).in('id', ids).select('id');
      if (error) return flash('改不動：' + error.message);
      if ((data?.length ?? 0) !== ids.length) {
        return flash(`要改 ${ids.length} 項，實際只改到 ${data?.length ?? 0} 項 —— 可能是權限`);
      }
      setPicked(new Set());
      await load();
      flash(`已標記 ${ids.length} 項為已採購`);
    } finally { setActing(false); }
  }

  /*
   * C · 會計手動改單一項目的狀態（2026-09-05 使用者要求）。
   *
   * ============================================================
   * 【這是逃生口，不是主要路徑】
   *
   * 平常狀態由觸發器維護：送審翻已採購、駁回退回、刪掉請款單退回
   * （migration_219）。這裡給那三條路都沒涵蓋到的情況用 ——
   * 東西臨時改成零用金買了、需求取消了、或是 219 之前卡住的舊資料。
   *
   * ★★ 退回開放狀態時**一定要清掉 `request_item_id`**
   *   （`manualStatusPatch` 負責，理由在 purchase-demand.ts）。
   *   不清的話那一項可以被再帶一次 ——
   *   同一筆錢出現在兩張請款單上，而總額只是「比較大」。
   *
   * ★ 影響列數要數。`pdi_write` 只放行會計以上，
   *   RLS 擋下的 UPDATE **回成功且 0 列**（CLAUDE.md）——
   *   不數的話畫面會顯示成功，重新整理才跳回原值。
   */
  async function setItemStatus(i: Demand['items'][number], to: DemandItemStatus) {
    if (acting || !i.id || to === i.status) return;
    const hadRequest = !!i.request_item_id;
    const note = manualStatusNote(to, hadRequest);
    if (note && !confirm(
      `把「${i.item_name}」改成「${ITEM_STATUS_LABEL[to]}」？\n\n${note}`
    )) return;

    setActing(true);
    try {
      const { data, error } = await supabase.from('purchase_demand_items')
        .update(manualStatusPatch(to, hadRequest))
        .eq('id', i.id).select('id');
      if (error) return flash('改不動：' + error.message);
      if (!data?.length) return flash('沒有改到任何一列 —— 可能是權限');
      await load();
      flash(`「${i.item_name}」改成${ITEM_STATUS_LABEL[to]}`);
    } finally { setActing(false); }
  }

  /*
   * D · 改平台／預計到貨／採購日（migration_222）。
   *
   * ★ 這三欄**不受 `trg_pdi_lock` 管**（它只鎖品名、數量、物業、規格）——
   *   已經轉成請款單的項目還是補得了到貨日，那正是要的行為。
   *
   * ★★ 一樣要數影響列數。`pdi_write` 只放行會計以上，
   *   RLS 擋下的 UPDATE 回成功且 0 列（CLAUDE.md）。
   *
   * ★ 空字串存成 null —— 清空日期欄時不要留一個 '' 進資料庫，
   *   `date` 欄位收到空字串會直接報型別錯誤。
   */
  async function setItemField(
    i: Demand['items'][number],
    patch: { platform?: string | null; eta?: string | null; purchased_on?: string | null },
  ) {
    if (acting || !i.id) return;
    const clean = Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [k, (v ?? '') === '' ? null : v]));
    setActing(true);
    try {
      const { data, error } = await supabase.from('purchase_demand_items')
        .update(clean).eq('id', i.id).select('id');
      if (error) return flash('改不動：' + error.message);
      if (!data?.length) return flash('沒有改到任何一列 —— 可能是權限');
      await load();
    } finally { setActing(false); }
  }

  useEffect(() => {
    supabase.from('estates').select('id, name').eq('active', true).order('sort')
      .then(({ data }) => setEstates(data ?? []));
  }, [supabase]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('purchase_demands')
      .select(`id, demand_no, requester_id, requested_on, note, status, ship_to, ship_floor,
               profiles(name),
               purchase_demand_items(
                 id, item_name, spec, purpose_type, estate_id, buy_link, status, request_item_id,
                 platform, eta, purchased_on,
                 purchase_request_items(purchase_requests(req_no))
               )`)
      .order('requested_on', { ascending: false })
      .order('demand_no', { ascending: false })
      .limit(200);

    setRows(((data as any[]) ?? []).map((d) => ({
      id: d.id,
      demand_no: d.demand_no,
      requester_id: d.requester_id,
      requester_name: d.profiles?.name ?? null,
      requested_on: d.requested_on,
      note: d.note,
      ship_to: d.ship_to,
      ship_floor: d.ship_floor,
      status: d.status,
      items: (d.purchase_demand_items ?? []).map((i: any) => ({
        id: i.id, item_name: i.item_name, spec: i.spec ?? '',
        purpose_type: i.purpose_type === 'office' ? 'office' : 'estate',
        estate_id: i.estate_id ?? '', buy_link: i.buy_link ?? '', status: i.status,
        platform: i.platform ?? null, eta: i.eta ?? null,
        purchased_on: i.purchased_on ?? null,
        request_item_id: i.request_item_id,
        request_no: i.purchase_request_items?.purchase_requests?.req_no ?? null,
      })),
    })));
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const estateName = useMemo(
    () => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);

  // ── 新增 ───────────────────────────────────────────
  /*
   * `/housekeeping?tab=demand&new=1` 直接開新增視窗（2026-08-22）。
   *
   * 請款頁的「＋ 採購單」以前是外部 Google 表單 —— 填完的東西
   * **不會進系統**，要有人手動看信再轉成採購需求。
   * 現在那顆按鈕導到這裡，同一份資料、同一張表。
   *
   * 只認一次 —— 開完就把參數從網址拿掉，不然重新整理會一直跳出來。
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    if (u.searchParams.get('new') !== '1') return;
    u.searchParams.delete('new');
    window.history.replaceState(null, '', u.toString());
    startNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startNew() {
    setEdit({ note: '', ship_to: '', ship_floor: '', items: [blankItem()] });
  }

  async function save() {
    if (!edit || !profile) return;
    /*
     * 【前端先擋，因為資料庫的錯誤訊息看不懂】
     *
     * `item_name` 與 `estate_id` 是 NOT NULL —— 沒填的話 Supabase 會回
     * 「null value in column "estate_id" violates not-null constraint」，
     * 而填表的人不知道 estate_id 是什麼。
     */
    /*
     * ★★★ 驗證規則在 `lib/demand.ts`,**跟按鈕的 disabled 共用同一支**。
     *   兩份各寫一次的話遲早會漂 —— 而漂掉的症狀是
     *   「按鈕亮著卻送不出去」或「填好了按鈕還是灰的」,
     *   兩種都只會讓人覺得系統壞了。（migration_186 加辦公室時差點漏掉其中一份）
     */
    const bad = validateDemand(edit.items, edit.ship_to);
    if (bad) return onMsg(bad, true);
    const items = edit.items.filter(isFilled);

    setSaving(true);
    const { data: d, error } = await supabase.from('purchase_demands')
      .insert({ requester_id: profile.id, note: edit.note.trim() || null,
                ship_to: edit.ship_to, ship_floor: edit.ship_floor.trim() || null })
      .select('id').single();
    if (error || !d) { setSaving(false); return onMsg('建立失敗：' + (error?.message ?? ''), true); }

    const { error: e2 } = await supabase.from('purchase_demand_items').insert(
      items.map((i) => ({
        demand_id: d.id, item_name: i.item_name.trim(), spec: i.spec.trim() || null,
        purpose_type: i.purpose_type,
        /*
         * ★★ office 一定寫 null，不是空字串也不是留著上一次的物業。
         *   互斥約束（`pdi_purpose_one_of`）會擋，但擋下來的訊息看不懂 ——
         *   而且真正的傷害是「沒擋住」的那種寫法:報表照 estate_id 分組，
         *   一筆同時算進辦公室與那個物業，兩邊都對不上。
         */
        estate_id: estateIdToSave(i),
      })));
    setSaving(false);
    if (e2) {
      /*
       * 項目寫失敗要把單也刪掉 —— 留一張沒有項目的空單在列表上，
       * 而它的狀態會是「尚未採購」，看起來像正常的一筆。
       */
      await supabase.from('purchase_demands').delete().eq('id', d.id);
      return onMsg('項目儲存失敗：' + e2.message, true);
    }
    setEdit(null);
    onMsg('採購需求已送出');
    load();
  }

  /*
   * 【可以送出了嗎】
   *
   * 跟 save() 裡的驗證是**同一組條件** —— 分成兩份的話,
   * 按鈕亮著卻送不出去（或反過來）,而使用者只會覺得系統壞了。
   *
   * 這裡只負責「亮不亮」,save() 仍然要再驗一次:
   * 按鈕的 disabled 擋得住滑鼠,擋不住 Enter 鍵與程式呼叫。
   */
  const canSubmit = useMemo(
    // ★ 跟 save() 呼叫同一支（lib/demand.ts）—— 條件不可能再漂掉
    () => !!edit && validateDemand(edit.items, edit.ship_to) === null,
    [edit],
  );

  const setItem = (idx: number, patch: Partial<Item>) =>
    setEdit((e) => e && ({ ...e, items: e.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }));

  // ── 畫面 ───────────────────────────────────────────
  const pendingTotal = rows.reduce((a, d) =>
    a + d.items.filter((i) => i.status === 'pending' || i.status === 'quoted').length, 0);

  return (
    <div className="px-4 md:px-0">
      {/*
        ★ 訊息放在動作發生的地方附近 —— 建請款單／標為已採購的結果
          要看得到（CLAUDE.md:錯誤訊息跳在頁面最上方而使用者在下半部操作,
          他按了鈕、什麼都沒發生,結論是「按鈕壞了」）。
      */}
      {msg && (
        <div className="mb-3 rounded-lg bg-mor-bluelight text-mor-slate px-3 py-2 text-sm">{msg}</div>
      )}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="text-xs text-gray-400 mr-auto">
          共 {rows.length} 張
          {pendingTotal > 0 && <span className="ml-2 text-amber-700">・{pendingTotal} 項還沒採購</span>}
        </div>
        <button onClick={startNew}
          className="rounded-lg bg-mor-slate text-white px-4 py-2 text-sm font-medium hover:bg-mor-slatedark">
          + 新增採購需求
        </button>
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-16">載入中…</div>
      ) : !rows.length ? (
        <div className="rounded-xl border border-dashed border-mor-line bg-white px-6 py-16 text-center text-gray-400">
          還沒有採購需求。按右上角新增。
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((d) => {
            const p = demandProgress(d.items, d.status === 'cancelled');
            const isOpen = open.has(d.id);
            return (
              <div key={d.id} className="rounded-xl glass overflow-hidden">
                {/*
                  整列可點開。摘要那一行已經回答了「買了沒、還缺什麼」——
                  展開只是為了看每一項的細節，不是必要動作。
                */}
                <button onClick={() => setOpen((s) => {
                  const n = new Set(s); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n;
                })}
                  className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-mor-sand/30">
                  <span className="font-medium text-sm">{d.demand_no ?? '（未編號）'}</span>
                  {seesAll && (
                    <span className="text-xs text-gray-500">{d.requester_name ?? '—'}</span>
                  )}
                  <span className="text-xs text-gray-400">{d.requested_on}</span>
                  {/* ★ 用 demandClass 不是 DEMAND_STATUS_CLASS[p.status] ——
                      「已採購」是顯示字，不在那四個 status 值裡（migration_219） */}
                  <span className={`ml-auto inline-block rounded-md px-2 py-0.5 text-xs font-medium
                                    ${demandClass(p)}`}>
                    {p.label}
                  </span>
                  <span className="w-full text-xs text-gray-500">
                    {progressText(p)}
                    {d.ship_to && (
                      <span className="ml-2 text-gray-400">
                        寄 {d.ship_to}{d.ship_floor ? `・${d.ship_floor}` : ''}
                      </span>
                    )}
                  </span>
                </button>

                {isOpen && (
                  <div className="border-t border-mor-line/60 divide-y divide-mor-line/40">
                    {/*
                      ★★★ 動作列只給會計以上（2026-09-05）。
                        房務提需求的人不該建請款單 —— `purchase_requests`
                        的 RLS 也是這樣寫的。藏起來不是為了安全，是為了不騙人:
                        看得到卻按不動的按鈕比沒有那顆按鈕更糟。
                    */}
                    {seesAll && (
                      <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-mor-sand/25">
                        <span className="text-xs text-gray-500">
                          {pickedIn(d).length
                            ? `已勾 ${pickedIn(d).length} 項`
                            : '勾選要處理的項目'}
                        </span>
                        <div className="ml-auto flex gap-2">
                          <button onClick={() => void makeRequest(d)}
                            disabled={acting || !pickedIn(d).filter((i) => isTakeable(i.status)).length}
                            className="rounded-lg bg-mor-slate text-white px-3 py-1.5 text-xs font-medium disabled:opacity-40">
                            建請款單
                          </button>
                          {/* ★ 零用金直接買的那條路。不產生請款單 —— 確認視窗會講 */}
                          <button onClick={() => void markDone(d)}
                            disabled={acting || !pickedIn(d).filter(canMarkDone).length}
                            className="rounded-lg border border-mor-slate/50 bg-white text-mor-slate px-3 py-1.5 text-xs font-medium disabled:opacity-40">
                            標為已採購
                          </button>
                        </div>
                      </div>
                    )}
                    {d.items.map((i) => (
                      <div key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                        {/*
                          ★★ 已經被領走的不給勾 —— 再帶一次會變成兩張請款單
                            請同一筆錢，而總額只是「比較大」，沒有地方會叫。
                        */}
                        {seesAll && (
                          isTakeable(i.status)
                            ? (
                              <input type="checkbox" checked={!!i.id && picked.has(i.id)}
                                onChange={() => i.id && togglePick(i.id)}
                                onClick={(e) => e.stopPropagation()} />
                            )
                            : <span className="w-[13px]" aria-hidden />
                        )}
                        <span className="font-medium">{i.item_name}</span>
                        <span className="text-xs rounded bg-mor-sand px-1.5 py-0.5">
                          {i.purpose_type === 'office' ? '安幸辦公室' : estateName[i.estate_id] ?? '—'}
                        </span>
                        {/* 規格說明裡就有大概數量 —— 沒有獨立的數量欄（migration_141） */}
                        {i.spec && <span className="text-xs text-gray-400">{i.spec}</span>}
                        {i.buy_link && (
                          <a href={i.buy_link} target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-xs text-mor-slate underline">建議連結</a>
                        )}
                        {/*
                          ★★ 平台與兩個日期（migration_222）。
                            順序照使用者指定:**平台在到貨前面**。

                          ★ 三個都只有會計以上改得動 —— 跟狀態下拉同一組權限。
                            房務與管家看得到值，但那是唯讀的文字。

                          ★★★ 平台**只給下拉不給打字**。自由打字的話
                            「蝦皮」跟「蝦皮購物」會變成兩個平台，而報表分不開
                            —— 資料庫那一欄刻意沒有 check（多一個平台不該要
                            一支 migration），所以擋錯字的責任在這裡。
                        */}
                        {seesAll ? (
                          <span className="flex items-center gap-1.5 text-xs">
                            <select value={i.platform ?? ''}
                              disabled={acting || !i.id}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => i.id && void setItemField(i, { platform: e.target.value })}
                              className="rounded-lg border border-mor-line bg-white px-1.5 py-0.5 text-xs disabled:opacity-40">
                              <option value="">平台</option>
                              {PURCHASE_PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
                              {/* ★ 舊資料的值不在清單裡也要選得回來，不然一改就掉 */}
                              {i.platform && !PURCHASE_PLATFORMS.includes(i.platform as never) && (
                                <option value={i.platform}>{i.platform}</option>
                              )}
                            </select>
                            <label className="flex items-center gap-1 rounded-lg border border-mor-line bg-white px-1.5 py-0.5">
                              <span className="text-gray-400">到貨</span>
                              <input type="date" value={i.eta ?? ''}
                                disabled={acting || !i.id}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => i.id && void setItemField(i, { eta: e.target.value })}
                                className="bg-transparent text-xs w-[7.5rem] disabled:opacity-40" />
                            </label>
                            <label className="flex items-center gap-1 rounded-lg border border-mor-line bg-white px-1.5 py-0.5">
                              <span className="text-gray-400">採購</span>
                              <input type="date" value={i.purchased_on ?? ''}
                                disabled={acting || !i.id}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => i.id && void setItemField(i, { purchased_on: e.target.value })}
                                className="bg-transparent text-xs w-[7.5rem] disabled:opacity-40" />
                            </label>
                          </span>
                        ) : (
                          /* 唯讀那一側:沒填的整格不出現，不要印一排「—」 */
                          <span className="flex items-center gap-1.5 text-xs text-gray-500">
                            {i.platform && <span className="rounded bg-mor-sand px-1.5 py-0.5">{i.platform}</span>}
                            {i.eta && <span>到貨 {i.eta.slice(5)}</span>}
                            {i.purchased_on && <span>採購 {i.purchased_on.slice(5)}</span>}
                          </span>
                        )}
                        <span className="ml-auto flex items-center gap-1.5 text-xs text-gray-500">
                          {/*
                            買了沒的答案就在這裡 —— 不用去請款頁查。
                            房務連請款頁的選單都沒有。
                          */}
                          {i.request_no && <span className="text-mor-slate">{i.request_no}</span>}
                          {/*
                            ★★ 卡住的那種要標出來:狀態說已進請款，卻接不到任何請款項目。
                              不標的話它看起來就是一筆正常的「已進請款」，而它永遠不會前進
                              （migration_219 之前刪掉請款單就會產生這種）。
                          */}
                          {isOrphanRequested(i) && (
                            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700"
                              title="狀態是已進請款，但接不到任何請款單。改成「未採購」就能重新帶進請款單。">
                              接不到單
                            </span>
                          )}
                          {seesAll
                            ? (
                              /*
                               * ★ 逃生口。平常狀態由觸發器維護（送審翻已採購、駁回退回、
                               *   刪掉請款單退回），這裡給那三條路沒涵蓋到的情況用。
                               */
                              <select value={i.status}
                                disabled={acting || !i.id}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => i.id && void setItemStatus(i, e.target.value as DemandItemStatus)}
                                className="rounded-lg border border-mor-line bg-white px-1.5 py-0.5 text-xs disabled:opacity-40">
                                {manualStatusOptions(i).map((s) => (
                                  <option key={s} value={s}>{ITEM_STATUS_LABEL[s]}</option>
                                ))}
                              </select>
                            )
                            : ITEM_STATUS_LABEL[i.status]}
                        </span>
                      </div>
                    ))}
                    {d.note && (
                      <div className="px-4 py-2 text-xs text-gray-500">備註：{d.note}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── 新增視窗 ──────────────────────────────── */}
      {edit && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center"
          onClick={() => !saving && setEdit(null)}>
          <div onClick={(e) => e.stopPropagation()}
            className="bg-white w-full md:w-[720px] md:max-w-[95vw] max-h-[92vh] overflow-auto
                       rounded-t-2xl md:rounded-2xl shadow-xl">
            <div className="sticky top-0 bg-white z-10 flex items-center justify-between px-4 py-3
                            border-b border-mor-line">
              <span className="font-medium">新增採購需求</span>
              <div className="flex gap-2">
                <button onClick={() => setEdit(null)} disabled={saving}
                  className="rounded-lg border border-mor-line px-3 py-1.5 text-sm">取消</button>
                {/*
                  沒填完就鎖住。**但滑鼠移上去要說得出為什麼** ——
                  一顆灰掉而不解釋的按鈕，使用者會以為是系統壞了而一直點。
                */}
                <button onClick={save} disabled={saving || !canSubmit}
                  title={canSubmit ? '' : '品名、用途、寄送地點都要填'}
                  className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium
                             disabled:opacity-40 disabled:cursor-not-allowed">
                  {saving ? '送出中…' : '送出'}
                </button>
              </div>
            </div>

            <div className="p-4 space-y-3">
              <p className="text-xs text-gray-400">
                <span className="text-red-500">*</span> 是必填，填完「送出」才會亮。{' '}
                <b className="text-gray-500">不用填金額與數量</b> —— 金額由會計詢價後在轉請款時填；
                大概要幾個寫在「規格說明」裡就好。
                用途選<b className="text-gray-500">物業</b>不是房號，採購多半是整棟共用的。
              </p>

              {edit.items.map((it, idx) => (
                <div key={idx} className="rounded-xl border border-mor-line p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 w-8">{idx + 1}.</span>
                    {/*
                      placeholder 只吃純文字，塞不進 <Req /> —— 所以用 ReqMark
                      把紅星畫在框線的左上角（跟請款單的項目列同一個做法）。
                    */}
                    <span className="relative flex-1">
                      <ReqMark />
                      <input value={it.item_name} onChange={(e) => setItem(idx, { item_name: e.target.value })}
                        placeholder="品名" className={`${inp} w-full`} />
                    </span>
                    {edit.items.length > 1 && (
                      <button onClick={() => setEdit((e) => e && ({ ...e, items: e.items.filter((_, i) => i !== idx) }))}
                        className="text-red-500 hover:text-red-700 text-sm px-1">✕</button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-10">
                    <span className="relative">
                      <ReqMark />
                      {/*
                        ★ 一個下拉同時管兩件事（跟支出頁、請款單同一套寫法）:
                          選 `office` → purpose_type='office'、estate_id 清空
                          選物業      → purpose_type='estate'、estate_id=那個 id

                        ★★ 拆成兩個欄位（先選類別再選物業）的話，
                          九成的情況要多按一次 —— 而那九成都是選物業。
                      */}
                      <select
                        value={it.purpose_type === 'office' ? 'office' : it.estate_id}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === 'office') setItem(idx, { purpose_type: 'office', estate_id: '' });
                          else setItem(idx, { purpose_type: 'estate', estate_id: v });
                        }}
                        className={`${inp} w-32`}>
                        <option value="">用途</option>
                        <option value="office">安幸辦公室</option>
                        {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                      </select>
                    </span>
                    <input value={it.spec} onChange={(e) => setItem(idx, { spec: e.target.value })}
                      placeholder="規格說明／大概數量" className={`${inp} flex-1 min-w-[8rem]`} />
                    <input value={it.buy_link} onChange={(e) => setItem(idx, { buy_link: e.target.value })}
                      placeholder="建議採購連結（蝦皮、露天…）" className={`${inp} flex-1 min-w-[10rem]`} />
                  </div>
                </div>
              ))}

              <button onClick={() => setEdit((e) => e && ({ ...e, items: [...e.items, blankItem()] }))}
                className="w-full rounded-xl border border-dashed border-mor-line py-2 text-sm
                           text-gray-500 hover:bg-mor-sand/40">
                + 加一個項目
              </button>

              {/*
                ── 寄送 ──────────────────────────────
                **一張單只有一個寄送地點。**

                這批東西會一起寄到同一個地方。放在每一個項目上的話，
                填的人要為五樣東西各選一次同樣的地點 —— 而真的要分開寄時，
                會計還得拆成兩張請款單才寄得對。

                要分開寄就開兩張需求單。那比每一項都問一次誠實。
              */}
              <div className="rounded-xl bg-mor-sand/40 p-3 space-y-2">
                <div className="text-xs text-gray-500">
                  寄送地點 <b className="text-gray-600">一張單一個</b> ——
                  要分開寄請另外開一張
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="relative">
                  <ReqMark />
                  <select value={edit.ship_to}
                    onChange={(e) => setEdit((x) => x && ({ ...x, ship_to: e.target.value }))}
                    className={`${inp} w-36`}>
                    <option value="">寄送地點</option>
                    {estates.map((e) => <option key={e.id} value={e.name}>{e.name}</option>)}
                    {SHIP_EXTRA.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                  </span>
                  <input value={edit.ship_floor}
                    onChange={(e) => setEdit((x) => x && ({ ...x, ship_floor: e.target.value }))}
                    placeholder="送達樓層／位置（例：2樓儲藏室）"
                    className={`${inp} flex-1 min-w-[12rem]`} />
                </div>
              </div>

              <textarea value={edit.note} onChange={(e) => setEdit((x) => x && ({ ...x, note: e.target.value }))}
                rows={2} placeholder="整張單的備註（選填）"
                className={`${inp} w-full resize-y`} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
