'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { SortTh, sortRows, type SortState, type SortCols } from '@/lib/sortable';
import { createClient } from '@/lib/supabase';
import Receipts from '@/components/Receipts';
import RefundFields, { METHOD_LABEL, METHOD_OPTS } from '@/components/RefundFields';
import { shareDeposit } from '@/lib/share';

/**
 * 押金管理。
 *
 * 金額不在這裡改 —— 那是契約條件的一部分,來源在 orders / contracts,
 * 由觸發器同步過來(migration_56)。這一頁只管「錢什麼時候收、什麼時候退、走哪個帳戶」。
 *
 * 暫收 = 有 received_on 且沒有 returned_on。
 */

type Dep = {
  id: string;
  order_id: string | null; contract_id: string | null;
  estate_id: string | null; property_id: string | null;
  room: string | null; guest_name: string | null;
  currency: string; amount: number;
  received_on: string | null; received_method: string | null; received_account: string | null;
  returned_on: string | null; returned_method: string | null; returned_account: string | null;
  note: string | null; orphaned: boolean; is_manual?: boolean; created_at: string;
  // 退款審核流程（migration_61）
  refund_status?: 'none' | 'pending' | 'approved' | 'rejected';
  payee_bank_code?: string | null; payee_name?: string | null; payee_account?: string | null;
  planned_refund_on?: string | null;
  manager_approved_at?: string | null; admin_approved_at?: string | null;
  reject_reason?: string | null;
};
type Estate = { id: string; name: string };
type PayAccount = { code: string; name: string; method: string };

// METHOD_LABEL / METHOD_OPTS 的定義搬到 @/components/RefundFields —— 只留一份

/**
 * 押金狀態。all 是「不分類」,pending/held/returned 三類互斥。
 *
 * orphan 與兩個 refund_* 都是**跨類別**的:一筆退款審核中的押金,
 * 錢還在我們手上,所以它同時也是 held。它們是「這筆押金現在卡在什麼事情上」,
 * 不是「錢在誰手上」,兩個問題不同,不能塞進同一組互斥分類。
 */
type Status = 'all' | 'pending' | 'held' | 'returned' | 'orphan' | 'refund_pending' | 'refund_approved';
const STATUS_LABEL: Record<Status, string> = {
  all: '全部', pending: '未收款', held: '已收款(暫收中)', returned: '已退款', orphan: '孤兒',
  refund_pending: '退款審核中', refund_approved: '已核可待匯款',
};

const fmt = (n: number | null) => (n == null ? '0' : Math.round(n).toLocaleString());
const todayStr = () => new Date().toISOString().slice(0, 10);

const COLS: SortCols<Dep> = {
  room: { type: 'text', get: (d) => d.room },
  guest_name: { type: 'text', get: (d) => d.guest_name },
  amount: { type: 'number', get: (d) => d.amount },
  received_on: { type: 'date', get: (d) => d.received_on },
  returned_on: { type: 'date', get: (d) => d.returned_on },
};

export default function DepositsPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<Dep[]>([]);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [payAccounts, setPayAccounts] = useState<PayAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  // 篩選
  const [fromD, setFromD] = useState('');
  const [toD, setToD] = useState('');
  const [estateF, setEstateF] = useState('');
  const [roomF, setRoomF] = useState('');
  const [methodF, setMethodF] = useState('');
  const [acctF, setAcctF] = useState('');
  // 分頁籤:一筆押金一定屬於其中一類,不會同時出現在兩個頁籤
  const [statusF, setStatusF] = useState<Status>('held');
  const [kwInput, setKwInput] = useState('');
  const [kw, setKw] = useState('');

  const [sort, setSort] = useState<SortState>({ key: 'received_on', dir: 'desc' });
  const [detail, setDetail] = useState<Dep | null>(null);
  const [edit, setEdit] = useState<Dep | null>(null);
  const [saving, setSaving] = useState(false);
  const [me, setMe] = useState<{ id: string; role: string } | null>(null);
  const [rejecting, setRejecting] = useState<Dep | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 3000); }

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('deposits').select('*').limit(5000);
    setRows((data ?? []) as Dep[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
    supabase.from('estates').select('id, name').eq('active', true).order('sort').order('name')
      .then(({ data }) => setEstates(data ?? []));
    supabase.from('payment_accounts').select('code, name, method').eq('active', true).order('sort')
      .then(({ data }) => setPayAccounts(data ?? []));
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setMe({ id: user.id, role: data?.role ?? '' });
    })();
  }, [load, supabase]);

  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);
  const acctName = useMemo(() => Object.fromEntries(payAccounts.map((a) => [a.code, a.name])), [payAccounts]);
  const rooms = useMemo(
    () => Array.from(new Set(rows.map((r) => r.room).filter(Boolean) as string[])).sort(),
    [rows]);

  // base 是「除了分頁籤以外」都套用的結果。
  // 卡片的數字要算在 base 上,不是 filtered —— 否則點進「未收款」之後,
  // 其他兩張卡片會全部歸零,那就不是總覽而是同一個數字抄三遍。
  const base = useMemo(() => rows.filter((r) => {
    // 日期區間比對「這筆押金最近一次動作」的日期:退了看退款日,否則看收款日。
    // 還沒收的沒有日期可比,設了區間就不顯示 —— 區間問的是「這段期間發生了什麼」,
    // 還沒發生的事不該混進來。未收款頁籤會另外提示。
    if (fromD || toD) {
      const d = r.returned_on ?? r.received_on;
      if (!d) return false;
      if (fromD && d < fromD) return false;
      if (toD && d > toD) return false;
    }
    if (estateF && r.estate_id !== estateF) return false;
    if (roomF && r.room !== roomF) return false;
    if (methodF && r.received_method !== methodF) return false;
    if (acctF && r.received_account !== acctF) return false;
    if (kw) {
      const hay = `${r.room ?? ''} ${r.guest_name ?? ''} ${r.note ?? ''}`.toLowerCase();
      if (!hay.includes(kw.toLowerCase())) return false;
    }
    return true;
  }), [rows, fromD, toD, estateF, roomF, methodF, acctF, kw]);

  /** 一筆押金必定落在三類的其中一類,順序不能顛倒:退了就是已退,不管收款日 */
  const bucketOf = (r: Dep) => (r.returned_on ? 'returned' : r.received_on ? 'held' : 'pending');

  /** 退款流程走到哪。returned_on 有值就是結案了,不再算在流程裡。 */
  const refundStage = (r: Dep) =>
    (r.returned_on ? 'done' : (r.refund_status ?? 'none'));

  const filtered = useMemo(() => base.filter((r) => {
    if (statusF === 'all') return true;
    if (statusF === 'orphan') return r.orphaned;
    if (statusF === 'refund_pending') return refundStage(r) === 'pending';
    if (statusF === 'refund_approved') return refundStage(r) === 'approved';
    return bucketOf(r) === statusF;
  }), [base, statusF]);

  const sorted = useMemo(() => sortRows(filtered, sort, COLS), [filtered, sort]);

  /** 各分頁籤的金額與筆數。依幣別分開 —— 外幣原幣退還不換匯,加總沒有意義。 */
  const stats = useMemo(() => {
    const mk = () => ({ n: 0, cur: {} as Record<string, number> });
    const s = {
      pending: mk(), held: mk(), returned: mk(), orphan: mk(),
      refund_pending: mk(), refund_approved: mk(),
    };
    for (const r of base) {
      const b = bucketOf(r) as 'pending' | 'held' | 'returned';
      s[b].n++;
      s[b].cur[r.currency] = (s[b].cur[r.currency] ?? 0) + Number(r.amount || 0);
      // 以下兩組跟上面三類重疊,是故意的 —— 見 Status 的說明
      if (r.orphaned) {
        s.orphan.n++;
        s.orphan.cur[r.currency] = (s.orphan.cur[r.currency] ?? 0) + Number(r.amount || 0);
      }
      const rs = refundStage(r);
      if (rs === 'pending' || rs === 'approved') {
        const k = rs === 'pending' ? 'refund_pending' : 'refund_approved';
        s[k].n++;
        s[k].cur[r.currency] = (s[k].cur[r.currency] ?? 0) + Number(r.amount || 0);
      }
    }
    return s;
  }, [base]);

  const fxLine = (cur: Record<string, number>) =>
    Object.entries(cur).filter(([c]) => c !== 'TWD').map(([c, v]) => `${c} ${fmt(v)}`).join('・');

  function clearFilters() {
    setFromD(''); setToD(''); setEstateF(''); setRoomF('');
    setMethodF(''); setAcctF(''); setKwInput(''); setKw('');
    setStatusF('held');   // 狀態也一起回到預設,否則「清除」之後還是看不到全部
  }

  /** 手動押金:不掛在任何訂單/契約下,金額與房源姓名可以直接填 */
  function blankManual(): Dep {
    return {
      id: '', order_id: null, contract_id: null, estate_id: null, property_id: null,
      room: '', guest_name: '', currency: 'TWD', amount: 0,
      received_on: null, received_method: null, received_account: null,
      returned_on: null, returned_method: null, returned_account: null,
      note: null, orphaned: false, is_manual: true, created_at: '',
      refund_status: 'none', payee_bank_code: null, payee_name: null, payee_account: null,
      planned_refund_on: null,
    };
  }

  const role = me?.role ?? '';
  const isManager = role === 'manager';
  const isAdmin = role === 'super_admin';
  const canRequest = ['accountant', 'manager', 'super_admin'].includes(role);

  /** 退款流程的權限判斷,集中一處 —— 分散寫遲早有一邊漏改 */
  function refundPerms(d: Dep) {
    const st = d.refund_status ?? 'none';
    return {
      st,
      // 還沒收到錢就沒有錢可以退。
      // pending 與 approved 也開放編輯 —— 存檔會清票重新送審(見 submitRefund),
      // 所以「改內容」跟「重新被審一次」永遠綁在一起,不可能繞過審核。
      // 真正的紅線是 returned_on:錢已經匯出去了就不能再改。
      canRequest: canRequest && !!d.received_on && !d.returned_on
        && ['none', 'rejected', 'pending', 'approved'].includes(st),
      canVoteMgr: isManager && st === 'pending' && !d.manager_approved_at,
      canVoteAdm: isAdmin && st === 'pending' && !d.admin_approved_at,
      canReject: (isManager || isAdmin) && st === 'pending',
      // 核可後才填實際退款日。這條也寫在 CHECK 約束裡,不是只靠前端。
      canSettle: canRequest && st === 'approved' && !d.returned_on,
    };
  }

  /**
   * 送出／更新退款申請。房客帳戶與預計匯款日在這一步就要填齊,審核者才有東西可看。
   *
   * 審核中或已核可改內容,都會清掉既有的票並退回重新送審 ——
   * 不清的話,「改收款帳號」就能在核可後把錢導到別的地方,兩票等於白審。
   * 跟請款單同一個道理。錢真的匯出去之後(returned_on)才不能再改。
   */
  async function submitRefund() {
    if (!edit) return;
    const wasSubmitted = edit.refund_status === 'pending' || edit.refund_status === 'approved';
    const hadVotes = !!edit.manager_approved_at || !!edit.admin_approved_at;
    if (wasSubmitted && hadVotes && !confirm(
      edit.refund_status === 'approved'
        ? '這筆退款已經核可通過。更新資訊會清掉核可票、退回重新送審,確定嗎?'
        : '這筆退款已經有人核可。更新資訊會清掉既有核可票並重新送審,確定嗎?'
    )) return;
    if (!edit.payee_account?.trim()) return flash('請填房客的收款帳號');
    if (!edit.payee_name?.trim()) return flash('請填戶名');
    if (!edit.planned_refund_on) return flash('請填預計匯款日');
    if (!edit.returned_method) return flash('請選我方出款方式');
    setSaving(true);
    const { error } = await supabase.from('deposits').update({
      refund_status: 'pending',
      payee_bank_code: edit.payee_bank_code?.trim() || null,
      payee_name: edit.payee_name.trim(),
      payee_account: edit.payee_account.trim(),
      planned_refund_on: edit.planned_refund_on,
      returned_method: edit.returned_method,
      returned_account: edit.returned_method !== 'cash' ? (edit.returned_account || null) : null,
      refund_requested_by: me?.id ?? null,
      note: edit.note || null,
      // 內容變了,既有的票就不算數
      manager_approved_by: null, manager_approved_at: null,
      admin_approved_by: null, admin_approved_at: null,
    }).eq('id', edit.id);
    setSaving(false);
    if (error) return flash('送審失敗:' + error.message);
    setEdit(null); flash(wasSubmitted ? '已更新並重新送審' : '已送出退款審核'); load();
  }

  /** 投票。兩票到齊由觸發器翻成 approved,前端不自己算狀態。 */
  async function vote(d: Dep) {
    if (!me) return;
    const patch: any = {};
    if (isManager) { patch.manager_approved_by = me.id; patch.manager_approved_at = new Date().toISOString(); }
    else if (isAdmin) { patch.admin_approved_by = me.id; patch.admin_approved_at = new Date().toISOString(); }
    else return flash('你的角色不能核可');
    const { error } = await supabase.from('deposits').update(patch).eq('id', d.id);
    if (error) return flash('核可失敗:' + error.message);
    setDetail(null); flash('已核可'); load();
  }

  async function doReject() {
    if (!rejecting || !me) return;
    if (!rejectReason.trim()) return flash('請填駁回原因');
    const { error } = await supabase.from('deposits').update({
      refund_status: 'rejected', rejected_by: me.id, reject_reason: rejectReason.trim(),
    }).eq('id', rejecting.id);
    if (error) return flash('駁回失敗:' + error.message);
    setRejecting(null); setRejectReason(''); flash('已駁回'); load();
  }

  /** 實際匯出後填退款日。填了才算「已退款」。 */
  async function settle(d: Dep, date: string) {
    const { error } = await supabase.from('deposits').update({ returned_on: date }).eq('id', d.id);
    if (error) return flash('儲存失敗:' + error.message);
    setDetail(null); flash('已完成退款'); load();
  }

  /**
   * 儲存「收押金」那一段與備註。
   *
   * 刻意不碰 returned_* —— 那三欄屬於退款流程,由 submitRefund() 與 settle() 管。
   * 早期版本這裡也一併寫,結果是:退款申請填好出款帳號後按「儲存」,
   * 因為 returned_on 還是空的,就把 returned_method / returned_account 清成 null,
   * 看起來像「存不進去」,實際上是存進去了但把值洗掉。
   * 一個欄位只該有一個地方負責寫。
   */
  async function save() {
    if (!edit) return;
    const manual = !!edit.is_manual;
    if (manual) {
      if (!(Number(edit.amount) > 0)) return flash('請填押金金額');
      if (!edit.room?.trim() && !edit.guest_name?.trim()) return flash('房源與姓名至少要填一個');
    }
    setSaving(true);
    const payload: any = {
      received_on: edit.received_on || null,
      received_method: edit.received_on ? (edit.received_method || null) : null,
      // 現金沒有帳戶可言。換了方式要把舊帳號清掉,否則會留下「現金 + 元大8088」這種組合。
      received_account: edit.received_on && edit.received_method !== 'cash' ? (edit.received_account || null) : null,
      note: edit.note || null,
    };
    // 連動列的這幾欄是來源的快照,改了下次同步就被蓋回去,所以只有手動列能改
    if (manual) {
      Object.assign(payload, {
        is_manual: true,
        estate_id: edit.estate_id || null,
        room: edit.room?.trim() || null,
        guest_name: edit.guest_name?.trim() || null,
        currency: edit.currency || 'TWD',
        amount: Number(edit.amount) || 0,
      });
    }
    const { error } = edit.id
      ? await supabase.from('deposits').update(payload).eq('id', edit.id)
      : await supabase.from('deposits').insert(payload);
    setSaving(false);
    if (error) return flash('儲存失敗:' + error.message);
    setEdit(null); flash('已儲存'); load();
  }

  async function del(d: Dep) {
    if (!confirm(`刪除這筆押金紀錄（${d.room ?? ''} ${d.guest_name ?? ''}）?`)) return;
    const { error } = await supabase.from('deposits').delete().eq('id', d.id);
    if (error) return flash('刪除失敗:' + error.message);
    setEdit(null); setDetail(null); flash('已刪除'); load();
  }

  /**
   * 下載 Excel。格式與請款單那份一致 —— 同一個人同一天可能兩份都要下載,
   * 長得不一樣只會讓對帳的人多花時間適應。
   *
   * 【欄位順序刻意分成四段】
   *   基本      物業 → 房源 → 姓名 → 幣別 → 押金
   *   收進來    收押金日 → 入款方式 → 入款帳號        ← 我方收在哪個帳戶
   *   退出去    預定退款日 → 退押金日 → 退款方式 → 退款帳號   ← 我方從哪個帳戶付
   *   對方      銀行代號 → 戶名 → 收款帳號            ← 錢要匯去哪
   *
   * 「我方帳號」在前、「對方資訊」在後,跟請款單同一個順序,
   * 也跟實際操作網銀時填的順序一致,複製貼上不用左右跳。
   *
   * 預定退款日與實際退押金日並排 —— 差幾天一眼就看得出來,
   * 那是「核可了但還沒匯」的積壓,分開放就沒人會去比。
   */
  function exportXlsx() {
    if (!sorted.length) return flash('沒有符合條件的押金紀錄');
    const BR = { style: 'thin', color: { rgb: 'C9C6BE' } };
    const BORD = { top: BR, bottom: BR, left: BR, right: BR };
    const stHead = { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: 'E7E4DC' } }, border: BORD, alignment: { horizontal: 'center' } };
    const stCell = { border: BORD };
    const stNum = { border: BORD, alignment: { horizontal: 'right' } };
    const T = (v: any, st: any) => ({ v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s: st, z: typeof v === 'number' ? '#,##0' : undefined });

    const header = ['物業', '房源', '姓名', '幣別', '押金',
      '收押金日', '入款方式', '入款帳號',
      '預定退款日', '退押金日', '退款方式', '退款帳號',
      '銀行代號', '戶名', '收款帳號',
      '狀態', '備註'];
    const aoa: any[][] = [header.map((h) => T(h, stHead))];
    for (const r of sorted) {
      aoa.push([
        T(r.estate_id ? estateName[r.estate_id] ?? '' : '', stCell),
        T(r.room ?? '', stCell),
        T(r.guest_name ?? '', stCell),
        T(r.currency, stCell),
        T(Math.round(Number(r.amount) || 0), stNum),
        T(r.received_on ?? '', stCell),
        T(r.received_method ? METHOD_LABEL[r.received_method] ?? r.received_method : '', stCell),
        // 入款帳號 = 押金收進我方哪個帳戶。跟銀行對帳要靠它。現金收的就是空的。
        T(r.received_account ? acctName[r.received_account] ?? r.received_account : '', stCell),
        T(r.planned_refund_on ?? '', stCell),
        T(r.returned_on ?? '', stCell),
        T(r.returned_method ? METHOD_LABEL[r.returned_method] ?? r.returned_method : '', stCell),
        // 退款帳號 = 錢從我方哪個帳戶出去
        T(r.returned_account ? acctName[r.returned_account] ?? r.returned_account : '', stCell),
        // 以下三欄是對方(房客)的收款資訊,退款申請核可時填的
        T(r.payee_bank_code ?? '', stCell),
        T(r.payee_name ?? '', stCell),
        // 帳號一律當文字。當數字的話 Excel 會吃掉開頭的 0,長帳號還會變科學記號
        T(r.payee_account ?? '', stCell),
        T(r.orphaned ? '孤兒' : r.returned_on ? '已退' : r.received_on ? '暫收中' : '尚未收', stCell),
        T(r.note ?? '', stCell),
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [
      { wch: 12 },  // 物業
      { wch: 10 },  // 房源
      { wch: 12 },  // 姓名
      { wch: 6 },   // 幣別
      { wch: 11 },  // 押金
      { wch: 12 },  // 收押金日
      { wch: 10 },  // 入款方式
      { wch: 18 },  // 入款帳號
      { wch: 12 },  // 預定退款日
      { wch: 12 },  // 退押金日
      { wch: 10 },  // 退款方式
      { wch: 18 },  // 退款帳號
      { wch: 10 },  // 銀行代號
      { wch: 18 },  // 戶名
      { wch: 20 },  // 收款帳號
      { wch: 10 },  // 狀態
      { wch: 24 },  // 備註
    ];
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '押金');
    // 檔名帶上當下的篩選條件 —— 下載三份不同條件的檔案放在同一個資料夾時,
    // 只靠日期分不出哪份是哪份。
    const tag = [statusF === 'all' ? '' : STATUS_LABEL[statusF],
      estateF ? estateName[estateF] ?? '' : '', roomF,
      methodF ? METHOD_LABEL[methodF] ?? '' : '',
      acctF ? acctName[acctF] ?? '' : '', kw].filter(Boolean).join('_');
    // 用本地日期,不用 toISOString() —— 那是 UTC,台灣凌晨下載會標成前一天
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `押金${tag ? '_' + tag : ''}_${stamp}.xlsx`);
  }

  /**
   * 核可票。○ 未投、✓ 已投 —— 一眼看得出卡在誰身上。
   * 只在審核中顯示;核可完了兩個都是 ✓,再顯示只是佔位置。
   */
  const voteLine = (r: Dep) => {
    if (r.refund_status !== 'pending') return null;
    return (
      <div className="text-[11px] text-gray-400 mt-0.5 whitespace-nowrap">
        <span className={r.manager_approved_at ? 'text-mor-green' : ''}>{r.manager_approved_at ? '✓' : '○'} 主管</span>
        <span className="mx-1">·</span>
        <span className={r.admin_approved_at ? 'text-mor-green' : ''}>{r.admin_approved_at ? '✓' : '○'} 總經理</span>
      </div>
    );
  };

  /** 退款流程的狀態標籤。跟押金本身的狀態（暫收/已退）是兩回事。 */
  const refundChip = (r: Dep) => {
    const st = r.refund_status ?? 'none';
    if (r.returned_on) return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-gray-100 text-gray-500">已退款</span>;
    if (st === 'approved') return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-mor-greenlight text-mor-green">已核可・待匯款</span>;
    if (st === 'pending') return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-amber-50 text-amber-700">退款審核中</span>;
    if (st === 'rejected') return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-red-50 text-red-600">已駁回</span>;
    return null;
  };

  const statusChip = (r: Dep) => {
    if (r.orphaned) return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-red-50 text-red-600">孤兒</span>;
    if (r.returned_on) return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-gray-100 text-gray-500">已退</span>;
    if (r.received_on) {
      // 退款流程進行中的,狀態欄直接顯示流程狀態 —— 「暫收中」看不出有人正在等核可
      const rc = refundChip(r);
      return rc ?? <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-mor-bluelight text-mor-slate">暫收中</span>;
    }
    return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-amber-50 text-amber-600">尚未收</span>;
  };

  const inp = 'rounded-lg border border-gray-300 px-2 py-1.5';

  // 未收款的列沒有任何日期,設了區間必然全空。直接說明,不要讓人以為資料不見了。
  const emptyHint = (statusF === 'pending' || statusF === 'all') && (fromD || toD)
    ? '未收款的押金還沒有收退日期,設了日期區間就不會出現。清除日期才看得到。'
    : '這一類目前沒有押金紀錄';

  return (
    <div>
      {msg && <div className="mb-3 rounded-lg bg-mor-greenlight text-mor-green px-3 py-2 text-sm">{msg}</div>}

      {/*
        三張卡片同時是分頁籤。數字算在 base 上(不含分頁籤本身的篩選),
        所以切到哪一類,另外兩類的數字都還在 —— 卡片是總覽,不是當前清單的重複。
      */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        {([
          { k: 'pending', title: '未收款', hint: '已填押金但還沒收到錢', tone: 'amber' },
          { k: 'held', title: '已收款(暫收中)', hint: '錢在我們手上,尚未退還', tone: 'slate' },
          { k: 'returned', title: '已退款', hint: '押金已退還給房客', tone: 'gray' },
        ] as const).map((t) => {
          const s = stats[t.k];
          const on = statusF === t.k;
          const fx = fxLine(s.cur);
          return (
            <button key={t.k} onClick={() => setStatusF(t.k)}
              className={`text-left rounded-xl p-5 min-w-0 border transition
                ${on
                  ? (t.tone === 'slate' ? 'bg-mor-slate text-white border-mor-slate'
                    : t.tone === 'amber' ? 'bg-amber-500 text-white border-amber-500'
                    : 'bg-gray-600 text-white border-gray-600')
                  : 'bg-white border-mor-line hover:border-gray-300'}`}>
              <div className={`text-xs ${on ? 'opacity-80' : 'text-gray-500'}`}>{t.title}</div>
              <div className="stat-num-lg font-bold mt-1">NT$ {fmt(s.cur['TWD'] ?? 0)}</div>
              <div className={`text-xs mt-1 ${on ? 'opacity-90' : 'text-gray-400'}`}>
                {fx && <span className="mr-2">{fx}</span>}
                共 {s.n} 筆
              </div>
              <div className={`text-xs mt-0.5 ${on ? 'opacity-70' : 'text-gray-400'}`}>{t.hint}</div>
            </button>
          );
        })}
      </div>

      {/*
        退款流程指標。

        上面三張卡回答「錢在誰手上」,這一列回答「有什麼卡著等人動作」——
        兩者刻意分開:一筆已核可待匯款的押金,錢還在我們手上,它同時算在「暫收中」裡。
        把它從暫收中扣掉的話,「我們現在保管多少錢」這個數字就不對了。

        這一列存在的理由很具體:核可已經搬到請款頁做了,
        會計回到這一頁時必須看得到「有幾筆等我匯出去」,否則那些單會安靜地卡著。

        沒有東西時整列不顯示 —— 兩個 0 只是視覺雜訊。
      */}
      {(stats.refund_pending.n > 0 || stats.refund_approved.n > 0) && (
        <div className="flex flex-wrap gap-2 mb-4">
          {stats.refund_pending.n > 0 && (
            <button onClick={() => setStatusF('refund_pending')}
              className={`rounded-lg px-3 py-2 text-xs border text-left transition
                ${statusF === 'refund_pending'
                  ? 'bg-amber-600 text-white border-amber-600'
                  : 'bg-amber-50 text-amber-700 border-amber-200 hover:border-amber-400'}`}>
              退款審核中 {stats.refund_pending.n} 筆・NT$ {fmt(stats.refund_pending.cur['TWD'] ?? 0)}
              <span className={`ml-2 ${statusF === 'refund_pending' ? 'opacity-80' : 'text-amber-600/70'}`}>等主管或總經理核可</span>
            </button>
          )}
          {stats.refund_approved.n > 0 && (
            <button onClick={() => setStatusF('refund_approved')}
              className={`rounded-lg px-3 py-2 text-xs border text-left transition
                ${statusF === 'refund_approved'
                  ? 'bg-mor-green text-white border-mor-green'
                  : 'bg-mor-greenlight text-mor-green border-mor-green/30 hover:border-mor-green/60'}`}>
              已核可待匯款 {stats.refund_approved.n} 筆・NT$ {fmt(stats.refund_approved.cur['TWD'] ?? 0)}
              <span className={`ml-2 ${statusF === 'refund_approved' ? 'opacity-80' : 'opacity-70'}`}>匯出後回來填退款日</span>
            </button>
          )}
        </div>
      )}

      {/* 孤兒是跨類別的狀態(可能未收也可能已收),沒有東西時完全不顯示 */}
      {stats.orphan.n > 0 && (
        <button onClick={() => setStatusF('orphan')}
          className={`mb-4 rounded-lg px-3 py-2 text-xs border w-full md:w-auto text-left
            ${statusF === 'orphan' ? 'bg-red-600 text-white border-red-600' : 'bg-red-50 text-red-600 border-red-200'}`}>
          ⚠ 孤兒 {stats.orphan.n} 筆・NT$ {fmt(stats.orphan.cur['TWD'] ?? 0)} —— 來源訂單或契約已刪除,但錢還在
        </button>
      )}

      {/* 篩選 */}
      <div className="filter-bar bg-white rounded-xl border border-mor-line p-4 mb-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">日期區間(收/退款日)</span>
          <div className="flex items-center gap-1">
            <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} className={inp} />
            <span className="text-gray-400">~</span>
            <input type="date" value={toD} onChange={(e) => setToD(e.target.value)} className={inp} />
          </div></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業</span>
          <select value={estateF} onChange={(e) => setEstateF(e.target.value)} className={`${inp} min-w-24`}>
            <option value="">全部</option>
            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">房源</span>
          <select value={roomF} onChange={(e) => setRoomF(e.target.value)} className={`${inp} min-w-24 max-w-40`}>
            <option value="">全部</option>
            {rooms.map((r) => <option key={r} value={r}>{r}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">入款方式</span>
          <select value={methodF} onChange={(e) => setMethodF(e.target.value)} className={inp}>
            <option value="">全部</option>
            {METHOD_OPTS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">入款帳號</span>
          <select value={acctF} onChange={(e) => setAcctF(e.target.value)} className={`${inp} min-w-28`}>
            <option value="">全部</option>
            {payAccounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">押金狀態</span>
          {/*
            跟上方的卡片是同一個狀態,點卡片或用這裡都行。
            卡片沒有「全部」—— 它們是三類的總覽,多一張「全部」卡片只是把三個數字再加一次。
            要跨類別看就用這個下拉。
          */}
          <select value={statusF} onChange={(e) => setStatusF(e.target.value as Status)} className={`${inp} min-w-28`}>
            {(['all', 'pending', 'held', 'returned'] as Status[]).map((k) => (
              <option key={k} value={k}>{STATUS_LABEL[k]}</option>
            ))}
            {stats.orphan.n > 0 && <option value="orphan">孤兒</option>}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">關鍵字(房源/姓名/備註)</span>
          <div className="flex items-center gap-1">
            <input value={kwInput} onChange={(e) => setKwInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwInput.trim()); }}
              placeholder="搜尋" className={`${inp} w-28`} />
            <button onClick={() => setKw(kwInput.trim())}
              className="rounded-lg bg-mor-slate text-white px-3 py-1.5 hover:bg-mor-slatedark">搜尋</button>
            {/* 清除放在搜尋旁邊 —— 清條件跟下條件是同一件事,分在畫面兩端要來回移動滑鼠 */}
            <button onClick={clearFilters}
              className="rounded-lg border border-gray-300 px-3 py-1.5">清除</button>
          </div></label>
        <div className="ml-auto flex gap-2">
          <button onClick={() => setEdit(blankManual())}
            className="rounded-lg border border-mor-slate text-mor-slate px-3 py-1.5 font-medium hover:bg-mor-sand/60">+ 手動新增</button>
          <button onClick={exportXlsx} disabled={!sorted.length}
            className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark disabled:opacity-40">⬇ 下載 Excel</button>
        </div>
      </div>

      {/* 手機卡片 */}
      <div className="md:hidden space-y-2">
        {loading ? <div className="text-center text-gray-400 py-10">載入中…</div>
        : sorted.length === 0 ? <div className="text-center text-gray-400 py-10 px-6 text-sm">{emptyHint}</div>
        : sorted.map((r) => (
          <div key={r.id} onClick={() => setDetail(r)}
            className="rounded-xl border border-mor-line bg-white p-4 active:bg-mor-sand/40">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium truncate">{r.room ?? '—'}</div>
                <div className="text-xs text-gray-500 truncate">{r.guest_name ?? '—'}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="stat-num font-bold">{r.currency === 'TWD' ? 'NT$' : r.currency} {fmt(r.amount)}</div>
                <div className="mt-1">{statusChip(r)}{voteLine(r)}</div>
              </div>
            </div>
            <div className="mt-2 text-xs text-gray-500">
              收 {r.received_on ?? '—'}
              {r.returned_on ? `・退 ${r.returned_on}` : ''}
            </div>
          </div>
        ))}
      </div>

      {/* 桌機表格 */}
      <div className="hidden md:block rounded-xl border border-mor-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-mor-line bg-mor-sand/40 text-left">
              <th className="px-3 py-2.5">物業</th>
              <SortTh label="房源" sortKey="room" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="姓名" sortKey="guest_name" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="押金" sortKey="amount" type="number" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="text-right" align="right" />
              <SortTh label="收押金日" sortKey="received_on" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5">入款方式</th>
              <SortTh label="退押金日" sortKey="returned_on" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5">退款方式</th>
              <th className="px-3 py-2.5">狀態</th>
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={10} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : sorted.length === 0 ? <tr><td colSpan={10} className="px-4 py-10 text-center text-gray-400 text-sm">{emptyHint}</td></tr>
            : sorted.map((r) => (
              <tr key={r.id} className="border-b border-mor-line/60 last:border-0 hover:bg-mor-sand/30">
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">{r.estate_id ? estateName[r.estate_id] ?? '—' : '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap font-medium">
                  {r.room ?? '—'}
                  {r.is_manual && <span className="ml-1 text-[10px] text-gray-400">手動</span>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{r.guest_name ?? '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {r.currency !== 'TWD' && <span className="text-xs text-gray-400 mr-1">{r.currency}</span>}
                  {fmt(r.amount)}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{r.received_on ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">
                  {r.received_method ? METHOD_LABEL[r.received_method] ?? r.received_method : '—'}
                  {r.received_account && <div className="text-gray-400">{acctName[r.received_account] ?? r.received_account}</div>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{r.returned_on ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">
                  {r.returned_method ? METHOD_LABEL[r.returned_method] ?? r.returned_method : '—'}
                  {r.returned_account && <div className="text-gray-400">{acctName[r.returned_account] ?? r.returned_account}</div>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{statusChip(r)}{voteLine(r)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap space-x-2">
                  <button onClick={() => setDetail(r)} className="text-xs text-mor-slate underline hover:text-mor-blue">檢視</button>
                  {/* 只有進了退款流程的才給分享 —— 還沒送審的單分享出去,對方點進待核可也看不到 */}
                  {(r.refund_status === 'pending' || r.refund_status === 'approved') && !r.returned_on && (
                    <button onClick={(e) => { e.stopPropagation(); shareDeposit(r); }}
                      className="text-xs text-mor-slate underline hover:text-mor-blue">分享</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 詳細抽屜 */}
      {detail && (() => {
        const d = detail;
        const row = (label: string, value: React.ReactNode) => (
          <div className="flex gap-3 py-1.5 border-b border-mor-line/40 last:border-0">
            <div className="w-24 shrink-0 text-xs text-gray-400 pt-0.5">{label}</div>
            <div className="flex-1 min-w-0 text-sm">{value ?? '—'}</div>
          </div>
        );
        return (
          <div className="fixed inset-0 z-50" onClick={() => setDetail(null)}>
            <div className="absolute inset-0 bg-black/30" />
            <div onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl overflow-y-auto">
              <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 flex items-start justify-between"
                style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
                <div className="min-w-0">
                  <div className="font-bold">{d.room ?? '—'}・{d.guest_name ?? '—'}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {d.is_manual ? '手動建立' : d.contract_id ? '契約押金' : '短租押金'}
                    {d.orphaned && <span className="text-red-600 ml-1">・來源已刪除</span>}
                  </div>
                </div>
                <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
              </div>

              <div className="px-6 py-4">
                {row('狀態', statusChip(d))}
                {row('物業', d.estate_id ? estateName[d.estate_id] ?? '—' : '—')}
                {row('押金', <span className="font-bold">{d.currency === 'TWD' ? 'NT$' : d.currency} {fmt(d.amount)}</span>)}
                {row('收押金日', d.received_on ?? '—')}
                {row('入款方式', d.received_method
                  ? `${METHOD_LABEL[d.received_method] ?? d.received_method}${d.received_account ? `・${acctName[d.received_account] ?? d.received_account}` : ''}`
                  : '—')}
                {(d.refund_status ?? 'none') !== 'none' && <>
                  {row('退款狀態', <span className="space-x-1">
                    {refundChip(d)}
                    {d.refund_status === 'pending' && (
                      <span className="text-xs text-gray-400">
                        主管 {d.manager_approved_at ? '✓' : '○'}・總經理 {d.admin_approved_at ? '✓' : '○'}
                      </span>
                    )}
                  </span>)}
                  {row('退到', d.payee_account
                    ? <span className="text-xs">{d.payee_name ?? ''} {d.payee_bank_code ?? ''} {d.payee_account}</span>
                    : '—')}
                  {row('預計匯款日', d.planned_refund_on ?? '—')}
                  {d.reject_reason ? row('駁回原因', <span className="text-red-600 text-xs">{d.reject_reason}</span>) : null}
                </>}
                {row('退押金日', d.returned_on ?? '—')}
                {row('退款方式', d.returned_method
                  ? `${METHOD_LABEL[d.returned_method] ?? d.returned_method}${d.returned_account ? `・${acctName[d.returned_account] ?? d.returned_account}` : ''}`
                  : '—')}
                {row('備註', d.note ? <span className="whitespace-pre-wrap">{d.note}</span> : '—')}

                <div className="mt-3"><Receipts kind="dep" parentId={d.id} label="憑證圖片" /></div>

                {!d.is_manual && (
                  <div className="mt-3 rounded-lg bg-mor-sand/60 text-gray-500 px-3 py-2 text-xs">
                    押金金額不在這裡改 —— 那是契約條件的一部分,請到
                    {d.contract_id ? '契約' : '短租訂單'}頁修改,這裡會自動同步。
                  </div>
                )}
              </div>

              <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3 flex flex-wrap gap-2"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
                {(() => {
                  const p = refundPerms(d);
                  const btn = 'flex-1 min-w-[5rem] h-11 rounded-lg text-sm font-medium';
                  return <>
                    <button onClick={() => { setEdit({ ...d }); setDetail(null); }}
                      className={`${btn} border border-mor-line`}>管理押金</button>
                    {/*
                      分享的連結指向請款頁的待核可分頁,不是這一頁 ——
                      核可統一在那裡做,主管點進去就能直接投票,不用自己找那一筆。
                    */}
                    <button onClick={() => shareDeposit(d)}
                      className={`${btn} border border-mor-line`}>↗ 分享</button>
                    {(p.canVoteMgr || p.canVoteAdm) && (
                      <button onClick={() => vote(d)} className={`${btn} bg-mor-green text-white`}>核可退款</button>
                    )}
                    {p.canReject && (
                      <button onClick={() => { setDetail(null); setRejecting(d); setRejectReason(''); }}
                        className={`${btn} border border-amber-400 text-amber-700`}>駁回</button>
                    )}
                    {p.canSettle && (
                      <button onClick={() => {
                        const v = prompt('實際退款日（YYYY-MM-DD）', d.planned_refund_on ?? todayStr());
                        if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) settle(d, v);
                        else if (v) flash('日期格式要是 YYYY-MM-DD');
                      }} className={`${btn} bg-mor-slate text-white`}>確認已退款</button>
                    )}
                    <button onClick={() => setDetail(null)}
                      className={`${btn} border border-gray-300`}>關閉</button>
                  </>;
                })()}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 駁回 */}
      {rejecting && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setRejecting(null)}>
          <div className="bg-white rounded-xl w-[420px] max-w-[92vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-mor-line px-6 py-4 font-bold">駁回退款・{rejecting.room ?? ''}</div>
            <div className="p-6 text-sm space-y-2">
              <div className="text-xs text-gray-500">駁回後退回申請人,可修改後重新送審。已投的票會一併清空。</div>
              <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                placeholder="駁回原因(必填)" className="w-full rounded-lg border border-mor-line px-2 py-1.5 h-24" />
            </div>
            <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
              <button onClick={() => setRejecting(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={doReject} className="rounded-lg bg-amber-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-amber-700">確認駁回</button>
            </div>
          </div>
        </div>
      )}

      {/* 管理押金 */}
      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-stretch md:items-start justify-center overflow-auto md:py-10 z-50"
          onClick={() => setEdit(null)}>
          <div className="bg-white w-full md:w-[560px] md:max-w-[95vw] md:rounded-xl shadow-xl min-h-full md:min-h-0"
            onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white border-b border-mor-line px-4 md:px-6 py-4 font-bold flex items-center justify-between z-10"
              style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
              {edit.id ? `管理押金・${edit.room ?? '—'}` : '手動新增押金'}
              <button onClick={() => setEdit(null)} aria-label="關閉"
                className="w-10 h-10 -mr-2 flex items-center justify-center text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <div className="p-4 md:p-6 space-y-4 text-sm">
              {edit.is_manual ? (
                /* 手動列沒有來源可同步,這幾欄就在這裡填 */
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {!edit.id && (
                    <div className="md:col-span-2 rounded-lg bg-amber-50 text-amber-700 px-3 py-2 text-xs">
                      手動押金不掛在任何訂單或契約下,適合舊約押金、代收、還沒開單就先收的訂金。
                    </div>
                  )}
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業</span>
                    <select value={edit.estate_id ?? ''} onChange={(e) => setEdit({ ...edit, estate_id: e.target.value || null })}
                      className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5">
                      <option value="">未指定</option>
                      {estates.map((es) => <option key={es.id} value={es.id}>{es.name}</option>)}
                    </select></label>
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">房源</span>
                    <input value={edit.room ?? ''} onChange={(e) => setEdit({ ...edit, room: e.target.value })}
                      placeholder="例:14B5"
                      className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5" /></label>
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">姓名</span>
                    <input value={edit.guest_name ?? ''} onChange={(e) => setEdit({ ...edit, guest_name: e.target.value })}
                      className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5" /></label>
                  <div className="flex gap-2">
                    <label className="flex flex-col gap-1 w-24"><span className="text-xs text-gray-500">幣別</span>
                      <select value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value })}
                        className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5">
                        {['TWD', 'USD', 'JPY', 'CNY', 'EUR'].map((c) => <option key={c} value={c}>{c}</option>)}
                      </select></label>
                    <label className="flex flex-col gap-1 flex-1 min-w-0"><span className="text-xs text-gray-500">押金金額 *</span>
                      <input type="number" min="0" value={edit.amount || ''}
                        onChange={(e) => setEdit({ ...edit, amount: e.target.value === '' ? 0 : Number(e.target.value) })}
                        className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 text-right" /></label>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg bg-mor-sand/60 px-3 py-2 text-xs text-gray-600">
                  {edit.guest_name ?? '—'}・押金 <span className="font-bold">{edit.currency === 'TWD' ? 'NT$' : edit.currency} {fmt(edit.amount)}</span>
                  <span className="text-gray-400 ml-1">(金額請到來源頁修改)</span>
                </div>
              )}

              <div className="border-t border-mor-line pt-3">
                <div className="text-xs font-semibold text-gray-500 mb-2">收押金</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">收押金日</span>
                    <input type="date" value={edit.received_on ?? ''}
                      onChange={(e) => setEdit({ ...edit, received_on: e.target.value || null })}
                      className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5" /></label>
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">入款方式</span>
                    <select value={edit.received_method ?? ''} disabled={!edit.received_on}
                      onChange={(e) => setEdit({ ...edit, received_method: e.target.value || null, received_account: null })}
                      className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-100">
                      <option value="">請選擇</option>
                      {METHOD_OPTS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
                    </select></label>
                  {/* 現金沒有帳戶可言 */}
                  {edit.received_method && edit.received_method !== 'cash' && (
                    <label className="flex flex-col gap-1 md:col-span-2"><span className="text-xs text-gray-500">入款帳號</span>
                      <select value={edit.received_account ?? ''}
                        onChange={(e) => setEdit({ ...edit, received_account: e.target.value || null })}
                        className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5">
                        <option value="">未指定</option>
                        {payAccounts.filter((a) => a.method === edit.received_method)
                          .map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                      </select></label>
                  )}
                </div>
                {!edit.received_on && (
                  <button onClick={() => setEdit({ ...edit, received_on: todayStr() })}
                    className="mt-2 text-xs text-mor-blue underline">填入今天</button>
                )}
              </div>

              {/*
                退押金是一條審核流,不是填個日期就好。
                押金動輒十幾二十萬,退錯追不回來 —— 這裡的關卡跟請款單同一套。

                兩個帳戶方向相反,命名沿用請款單:
                  payee_*          = 房客的收款帳戶（錢退到哪）
                  returned_account = 我方的出款帳號（錢從哪出）
              */}
              <div className="border-t border-mor-line pt-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-gray-500">退押金</span>
                  {refundChip(edit)}
                </div>

                {!edit.received_on ? (
                  <div className="text-xs text-gray-400">還沒收到押金,先填收款資訊。</div>
                ) : edit.refund_status === 'approved' ? (
                  /* 核可後鎖住。錢要出去了,改收款帳號等於繞過審核 —— 要改就先駁回。 */
                  <div className="space-y-1 text-xs text-gray-600">
                    <div className="rounded-lg bg-mor-greenlight text-mor-green px-3 py-2">
                      已核可,等待匯款。要修改內容請先請主管或總經理駁回。
                    </div>
                    <div className="pt-1">退到:{edit.payee_name} {edit.payee_bank_code} {edit.payee_account}</div>
                    <div>預計匯款日:{edit.planned_refund_on}</div>
                    <div>
                      我方出款:{edit.returned_method ? METHOD_LABEL[edit.returned_method] : '—'}
                      {edit.returned_account ? `・${acctName[edit.returned_account] ?? edit.returned_account}` : ''}
                    </div>
                  </div>
                ) : edit.returned_on ? (
                  <div className="text-xs text-gray-500">
                    已於 {edit.returned_on} 退還・
                    {edit.returned_method ? METHOD_LABEL[edit.returned_method] : ''}
                    {edit.returned_account ? `・${acctName[edit.returned_account] ?? edit.returned_account}` : ''}
                  </div>
                ) : (
                  <>
                    {edit.refund_status === 'rejected' && edit.reject_reason && (
                      <div className="rounded-lg bg-red-50 text-red-600 px-3 py-2 text-xs mb-3">
                        駁回原因:{edit.reject_reason}
                      </div>
                    )}
                    {edit.refund_status === 'pending' && (
                      <div className="rounded-lg bg-amber-50 text-amber-700 px-3 py-2 text-xs mb-3">
                        審核中,等待主管與總經理核可。這期間仍可修改後重新送審。
                      </div>
                    )}

                    {/* 欄位跟請款頁的押金抽屜共用同一支元件,不會各自演化 */}
                    <RefundFields v={edit} payAccounts={payAccounts} currency={edit.currency}
                      onChange={(patch) => setEdit({ ...edit, ...patch })} />

                    <p className="text-xs text-gray-400 mt-2">
                      送出後由主管與總經理各核可一次,核可後才能填實際退款日。
                    </p>
                  </>
                )}
              </div>

              {/* 匯款水單、房客提供的帳戶截圖都放這裡 */}
              {edit.id && <Receipts kind="dep" parentId={edit.id} label="憑證圖片" />}

              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">備註</span>
                <textarea value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                  className="bg-white rounded-lg border border-mor-line px-2 py-2 h-24 md:h-16" /></label>
            </div>

            <div className="sticky bottom-0 md:static bg-white border-t border-mor-line px-4 md:px-6 py-3 md:py-4 flex gap-2 md:justify-end"
              style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
              {/* 連動列不能刪 —— 刪了下次來源同步又會長回來,只會讓人以為壞掉 */}
              {edit.id && (edit.is_manual || edit.orphaned) && (
                <button onClick={() => del(edit)}
                  className="h-12 md:h-auto rounded-lg border border-red-300 text-red-600 px-4 md:py-1.5 text-sm">刪除</button>
              )}
              <button onClick={() => setEdit(null)}
                className="h-12 md:h-auto flex-1 md:flex-none rounded-lg border border-gray-300 px-4 md:py-1.5 text-sm">取消</button>
              <button onClick={save} disabled={saving}
                className="h-12 md:h-auto flex-1 md:flex-none rounded-lg border border-mor-line px-4 md:py-1.5 text-sm hover:bg-mor-sand/60 disabled:opacity-40">
                {saving ? '儲存中…' : '儲存'}</button>
              {/* 送審是獨立動作 —— 「儲存」只是留著待辦,不該悄悄啟動審核流程 */}
              {edit.id && refundPerms(edit).canRequest && (
                <button onClick={submitRefund} disabled={saving}
                  className="h-12 md:h-auto flex-1 md:flex-none rounded-lg bg-mor-slate text-white px-4 md:py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
                  送出退款審核</button>
              )}
              {edit.id && edit.refund_status === 'pending' && (
                <button onClick={submitRefund} disabled={saving}
                  className="h-12 md:h-auto flex-1 md:flex-none rounded-lg bg-mor-slate text-white px-4 md:py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
                  更新退款資訊</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
