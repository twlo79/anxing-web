'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Toast from '@/components/Toast';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { softDelete } from '@/lib/trash';

type Staff = { id: string; name: string; aliases: string[]; staff_type: string; active: boolean; sort: number; role?: string; email?: string | null; auth_uid?: string | null };
type Estate = { id: string; name: string; manager: string | null; sort: number; active: boolean };
type Property = { id: string; name: string; estate_id: string | null };
type Profile = { id: string; name: string | null; role: string; active: boolean };
/** 編輯紀錄（migration_72）。changes 格式:刪除/新增是整列,修改是 {欄位: [改前, 改後]} */
type Audit = {
  id: number; at: string; user_id: string | null; table_name: string;
  record_id: string | null; label: string | null; action: string; changes: any;
};

/** 每次爬蟲同步的數字（migration_113）。看趨勢用 —— 「今天怎麼新增了 80 筆」 */
type SyncRun = {
  id: number; at: string; kind: string;
  received: number; inserted: number; updated: number; voided: number; skipped: number;
  detail: Record<string, number> | null;
};
/**
 * 還沒解決的差異（migration_113）。
 * 這張表每次同步整批換掉 —— 修好對照表之後那一列隔天自己消失。
 */
type SyncIssue = {
  kind: string; code: string; field: string;
  first_seen: string; last_seen: string;
  from_val: string | null; to_val: string | null; listing_id: string | null;
  extra: Record<string, unknown> | null;
};

/** 常用收款對象（migration_96）。請款單不掛外鍵,填完就脫鉤。 */
type Payee = {
  id: string; label: string; bank_code: string | null; account: string;
  company: string | null; tax_id: string | null; note: string | null;
  sort: number; active: boolean;
};
type PayAccount = {
  id: string; method: string; code: string; name: string;
  for_income: boolean; for_payment: boolean; sort: number; active: boolean;
};

const METHOD_LABEL: Record<string, string> = { transfer: '匯款', credit_card: '信用卡' };

const TAB_LABEL = {
  people: '權限管理', estates: '物業與負責人', accounts: '收付款帳號',
  payees: '常用帳號', props: '房源管理',
  sync: '同步建議', audit: '編輯紀錄',
} as const;
type TabKey = keyof typeof TAB_LABEL;

/**
 * 會計看得到哪些分頁。
 *
 * 【為什麼不是整頁開放】
 * 「權限管理」分頁可以改人員角色 —— 能改角色就能把自己改成總經理，
 * 而請款單的兩票制正是 manager 一票 + super_admin 一票。
 * 開放那一頁等於「會計隨時可以繞過自己不能投票的限制」，
 * 而 data_audit 只會記下「改了」，不會阻止。
 *
 * 所以只開跟付款直接相關的兩張主檔：收付款帳號、常用帳號。
 * 物業負責人、房源、編輯紀錄仍然只有總經理看得到。
 */
const ACCOUNTANT_TABS: TabKey[] = ['accounts', 'payees'];

/** 編輯紀錄裡的表名要講人話 —— 沒人記得 purchase_request_items 是什麼 */
const AUDIT_TABLE: Record<string, string> = {
  expenses: '支出', purchase_requests: '請款單', purchase_request_items: '請款項目',
  deposits: '押金', orders: '訂單', contracts: '契約', reviews: '評價',
};
const AUDIT_ACTION: Record<string, string> = { insert: '新增', update: '修改', delete: '刪除' };
/** 這些欄位改了沒有意義,列表上省略,免得蓋掉真正重要的變動 */
const AUDIT_SKIP = new Set(['updated_at', 'created_at', 'id']);

/**
 * 爬蟲對每個欄位的處理方式（跟 lib/airbnb-sync.ts 的實作對應）。
 *
 * 【為什麼要把規則寫在畫面上】
 * 「我改的房源會不會被蓋掉」這個問題,不寫出來就只能靠問人 ——
 * 而問到的答案取決於對方記不記得。寫在旁邊,改資料的人自己看得到。
 */
const SYNC_TIERS: { level: string; tone: string; fields: string; why: string }[] = [
  { level: '一律更新', tone: 'bg-mor-bluelight text-mor-slate',
    fields: '取消（金額歸零）、訂單狀態、住宿起訖',
    why: '這三個不管有沒有人工改過都照做。原則是「會讓營收變小的自動套用」—— 少算有人會發現,多算不會:一筆已取消的訂單躺在營收裡看起來完全正常。住宿起訖兩個方向都更新,理由是行事曆:縮住不更新會推掉真訂單,延住不更新會重複出租。' },
  { level: '只在空的時候填', tone: 'bg-amber-50 text-amber-800',
    fields: '金額、房源、房客姓名',
    why: '這三個我們會手動修正,爬蟲不該贏。不一致列進下面的清單 —— 只是不覆蓋的話,對照表永遠是錯的。' },
  { level: '人改過就完全不填', tone: 'bg-red-50 text-red-600',
    fields: '上面那三個,只要這筆被人工編輯過',
    why: '連空的都不填 —— 那個空可能就是他刻意清掉的。系統從編輯紀錄判斷,而且是回溯的:2026-08 之前改的一樣算數。' },
  { level: '完全不碰', tone: 'bg-mor-greenlight text-mor-green',
    fields: '收款、押金、帳號、備註、發票、移房',
    why: '這些是人的判斷與金流紀錄,爬蟲沒有任何依據可以動它們。' },
];

/** 每一種差異該做什麼。沒有建議的清單只是一份焦慮清單。 */
const ISSUE_ADVICE: Record<string, string> = {
  金額: 'Airbnb 上的金額跟系統裡的不一樣。系統不會自己改 —— 金額是營收,它靜靜變動的代價遠大於晚一天更新。確認過再手動改。',
  房源: '到「房源管理」把這個 listing_id 搬到正確的房源。搬完隔天這一列自己會消失。',
  對不到房源: '這個 listing 在系統裡沒有對應的啟用房源,訂單根本沒進來。到「房源管理」補上對照。',
  房源名稱查不到: '通常是多間房源在 Airbnb 用了同一個標題（開封 2F/3F/4F 就是）。要靠訂單反查,或手動指定。',
  房客姓名: 'Airbnb 顯示名跟我們登記的正式姓名不同。多半不用處理 —— 除非你發現是對到錯的人。',
  住宿起訖: '日期已經跟著更新了。這裡列出來是因為它會改變營收攤提的月份,值得看一眼。',
  待人工判斷: 'Airbnb 顯示已取消且無收入,但系統裡標記為已收款。錢真的進來過就不能自動歸零 —— 要你判斷。',
};

/**
 * timestamptz 轉台北時間。
 *
 * 【為什麼不能直接切字串】
 * 原本寫的是 `at.slice(0, 16).replace('T', ' ')` —— 那切出來的是 **UTC**。
 * 早上 11:43 改的資料，畫面上顯示 03:43。
 *
 * 這個錯誤特別惡劣：時間看起來完全正常（格式對、順序對、也在遞增），
 * 只是整排晚了八小時。追「這筆是誰在什麼時候改的」時會得到完全錯誤的結論 ——
 * 我們就是這樣一度以為凌晨三點有人在改訂單。
 */
function twTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(/\//g, '-');
}

const TYPE_LABEL: Record<string, string> = { housekeeper: '管家', roomservice: '房務', manager: '經理', accountant: '會計', gm: '總經理', other: '其他' };
const TYPE_OPTS = ['housekeeper', 'roomservice', 'manager', 'accountant', 'gm', 'other'];
const ROLE_LABEL: Record<string, string> = { super_admin: '總經理', manager: '主管', accountant: '會計', housekeeper: '一般' };
// 職位 → 權限 一對一。職位是主軸,權限由職位決定,不再各改各的 ——
// 原本兩欄各自可改,結果同一個人可以是「管家職位 + 管理員權限」,對不起來。
const ROLE_OF: Record<string, string> = {
  housekeeper: 'housekeeper', roomservice: 'housekeeper', manager: 'manager',
  accountant: 'accountant', gm: 'super_admin', other: 'housekeeper',
};

export default function AdminPage() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [role, setRole] = useState<string | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [payAccounts, setPayAccounts] = useState<PayAccount[]>([]);
  const [selEstate, setSelEstate] = useState<string>('');
  const [newPropName, setNewPropName] = useState('');
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState<TabKey>('people');
  const [audits, setAudits] = useState<Audit[]>([]);
  const [auditTable, setAuditTable] = useState('');
  /**
   * 人工 / 自動。
   *
   * 【為什麼預設只看人工】
   * 這張表是拿來回答「誰改了什麼」的 —— 那個問題問的是人。
   * 爬蟲新增的雖然不多,但每天都有,混在一起會讓人每次都要先過濾一次眼睛。
   * 要查「這筆訂單哪來的」才切到全部。
   */
  const [auditWho, setAuditWho] = useState<'' | 'human' | 'auto'>('human');
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [issues, setIssues] = useState<SyncIssue[]>([]);
  const [acct, setAcct] = useState<{ staffId: string; name: string; mode: 'create' | 'password'; email: string; password: string; role: string } | null>(null);

  const load = useCallback(async () => {
    const { data: st } = await supabase.from('staff').select('*').order('sort').order('name');
    const { data: pf } = await supabase.from('profiles').select('id, name, role, active');
    const { data: es } = await supabase.from('estates').select('*').order('sort').order('name');
    const { data: pr } = await supabase.from('properties').select('id, name, estate_id').order('name');
    const { data: pa } = await supabase.from('payment_accounts').select('*').order('sort').order('code');
    setStaff(st ?? []);
    setProfiles(pf ?? []);
    setEstates(es ?? []);
    setProperties(pr ?? []);
    setPayAccounts(pa ?? []);
    setSelEstate((cur) => cur || es?.[0]?.id || '');
  }, [supabase]);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/login'); return; }
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setRole(data?.role ?? null);
      // 會計也要載 —— 他看得到收付款帳號與常用帳號兩個分頁
      if (data?.role !== 'super_admin' && data?.role !== 'accountant') return;
      load();
    });
  }, [supabase, router, load]);

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 2500); }

  // ---- 編輯紀錄 ----
  // 只在切到那個分頁時才載,而且限 300 筆 —— 這張表會一直長,
  // 每次進設定頁都全載會愈來愈慢。
  const loadAudit = useCallback(async () => {
    let q = supabase.from('data_audit').select('*').order('at', { ascending: false }).limit(300);
    if (auditTable) q = q.eq('table_name', auditTable);
    // user_id 是 null 就代表不是人在操作（service key、排程、觸發器）
    if (auditWho === 'human') q = q.not('user_id', 'is', null);
    if (auditWho === 'auto') q = q.is('user_id', null);
    const { data, error } = await q;
    if (error) return flash('編輯紀錄載入失敗:' + error.message);
    setAudits((data ?? []) as Audit[]);
  }, [supabase, auditTable, auditWho]);
  useEffect(() => { if (tab === 'audit') loadAudit(); }, [tab, loadAudit]);

  // ---- 同步建議 ----
  const loadSync = useCallback(async () => {
    const [{ data: r }, { data: i, error }] = await Promise.all([
      supabase.from('sync_runs').select('*').order('at', { ascending: false }).limit(12),
      supabase.from('sync_issues').select('*').order('first_seen', { ascending: true }),
    ]);
    if (error) return flash('同步紀錄載入失敗:' + error.message);
    setRuns((r ?? []) as SyncRun[]);
    setIssues((i ?? []) as SyncIssue[]);
  }, [supabase]);
  useEffect(() => { if (tab === 'sync') loadSync(); }, [tab, loadSync]);

  /*
   * 差異按種類分組。
   *
   * 不分組的話一百列長得一模一樣,而「房源不一致」跟「姓名不同」
   * 要做的事完全不同 —— 前者要去改對照表,後者通常不用理。
   */
  const issueGroups = useMemo(() => {
    const g: Record<string, SyncIssue[]> = {};
    for (const it of issues) (g[it.field] ??= []).push(it);
    return g;
  }, [issues]);

  // profiles.id 對回姓名。編輯紀錄只存 user_id,不存名字 ——
  // 存名字的話改名之後歷史紀錄會對不上人。
  const nameOfUser = useMemo(() => {
    const m: Record<string, string> = {};
    staff.forEach((st) => { if (st.auth_uid) m[st.auth_uid] = st.name; });
    profiles.forEach((pf) => { if (!m[pf.id] && pf.name) m[pf.id] = pf.name; });
    return m;
  }, [staff, profiles]);

  // ---- 人員 ----
  const activeHousekeepers = useMemo(() => staff.filter((s) => s.active && s.staff_type === 'housekeeper'), [staff]);
  // 有登入帳號(profiles)但名冊(staff)沒有對應列的孤兒帳號 —— 多半是直接用 SQL 建的
  const orphanAccounts = useMemo(() => {
    const linked = new Set(staff.map((s) => s.auth_uid).filter(Boolean));
    return profiles.filter((p) => !linked.has(p.id));
  }, [staff, profiles]);
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffType, setNewStaffType] = useState('housekeeper');

  async function addStaff() {
    const name = newStaffName.trim();
    if (!name) return;
    const { error } = await supabase.from('staff')
      .insert({ name, staff_type: newStaffType, role: ROLE_OF[newStaffType], active: true, sort: 50 });
    if (error) return flash('新增失敗:' + error.message);
    setNewStaffName(''); flash('已新增 ' + name); load();
  }
  // 改職位時連權限一起改 —— 兩者一對一,分開改遲早會不同步
  async function changeStaffType(s: Staff, staff_type: string) {
    const role = ROLE_OF[staff_type];
    const { error } = await supabase.from('staff').update({ staff_type, role }).eq('id', s.id);
    if (error) return flash('更新失敗:' + error.message);
    // 有登入帳號的人還要同步 profiles.role,否則權限不會真的生效
    if (s.auth_uid) { await callAcct({ action: 'role', staffId: s.id, role }); return; }
    flash('已更新'); load();
  }
  async function updateStaff(id: string, patch: Partial<Staff>) {
    const { error } = await supabase.from('staff').update(patch).eq('id', id);
    if (error) return flash('更新失敗:' + error.message);
    flash('已更新'); load();
  }
  async function callAcct(payload: Record<string, unknown>): Promise<boolean> {
    const { data: { session } } = await supabase.auth.getSession();
    const r = await fetch('/api/admin/staff-account', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (session?.access_token || '') }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { flash('失敗:' + (j.error || r.status)); return false; }
    flash('已更新'); load(); return true;
  }
  async function toggleActive(s: Staff) {
    const { error } = await supabase.from('staff').update({ active: !s.active }).eq('id', s.id);
    if (error) return flash('更新失敗:' + error.message);
    if (s.auth_uid) await callAcct({ action: 'ban', staffId: s.id, ban: s.active });
    else { flash(s.active ? '已設為離職' : '已恢復在職'); load(); }
  }
  // 刪除登入帳號:人留著,只是不能再登入。
  // 跟「設為離職」不一樣 —— 離職是封鎖帳號(還原得回來),
  // 這個是真的把 auth 使用者刪掉,email 可以拿去給別人用。
  async function deleteAccount(s2: Staff) {
    if (!s2.auth_uid) return;
    if (!confirm(
      `確定刪除「${s2.name}」的登入帳號?\n\n` +
      `・這個人在名冊上會留著,歷史紀錄不受影響\n` +
      `・但他從此無法登入,要重新建立帳號才行\n` +
      `・email（${s2.email ?? '未設定'}）會釋出,可以給別人用\n\n` +
      `只是暫時停用的話請用「設為離職」,那個還原得回來。`
    )) return;
    await callAcct({ action: 'delete_account', staffId: s2.id });
  }

  // 改姓名。改的是 staff.name,不動登入 email ——
  // 歷史紀錄靠 id 綁定,改名不會讓過去的資料對不上人。
  async function renameStaff(s2: Staff) {
    const name = prompt(`修改姓名（原：${s2.name}）`, s2.name)?.trim();
    if (!name || name === s2.name) return;
    await updateStaff(s2.id, { name });
  }

  async function saveAcct() {
    if (!acct) return;
    if (acct.mode === 'create') {
      if (!acct.email.trim() || !acct.password) return flash('請填 email 與密碼');
      if (acct.password.length < 6) return flash('密碼至少 6 碼');
      if (await callAcct({ action: 'create', staffId: acct.staffId, email: acct.email.trim(), password: acct.password, role: acct.role })) setAcct(null);
    } else {
      if (acct.password.length < 6) return flash('密碼至少 6 碼');
      if (await callAcct({ action: 'password', staffId: acct.staffId, password: acct.password })) setAcct(null);
    }
  }

  // ---- 物業 ----
  const [newEstateName, setNewEstateName] = useState('');
  async function addEstate() {
    const name = newEstateName.trim();
    if (!name) return;
    const { error } = await supabase.from('estates').insert({ name, sort: 50 });
    if (error) return flash('新增失敗:' + error.message);
    setNewEstateName(''); flash('已新增 ' + name); load();
  }
  async function updateEstate(id: string, patch: Partial<Estate>) {
    const { error } = await supabase.from('estates').update(patch).eq('id', id);
    if (error) return flash('更新失敗:' + error.message);
    flash('已更新'); load();
  }
  async function deleteEstate(id: string, name: string) {
    if (!confirm(`確定刪除物業「${name}」?此物業下的房源會失去物業歸屬(評價/清潔紀錄仍保留)。\n\n會移到回收桶,可以復原。`)) return;
    const r = await softDelete(supabase, 'estates', id);
    flash(r.message); if (r.ok) load();
  }

  // ---- 收付款帳號 ----
  const [newAcctMethod, setNewAcctMethod] = useState('transfer');
  const [newAcctCode, setNewAcctCode] = useState('');
  const [newAcctName, setNewAcctName] = useState('');

  // ---- 常用收款對象（migration_96）----
  const [payees, setPayees] = useState<Payee[]>([]);
  const [np, setNp] = useState({ label: '', bank_code: '', account: '', company: '', tax_id: '' });

  const loadPayees = useCallback(async () => {
    const { data } = await supabase.from('payee_presets').select('*').order('sort').order('label');
    setPayees((data ?? []) as Payee[]);
  }, [supabase]);
  useEffect(() => { if (tab === 'payees') loadPayees(); }, [tab, loadPayees]);

  async function addPayee() {
    const account = np.account.trim();
    if (!account) return flash('請填帳號');
    if (np.tax_id.trim() && !/^[0-9]{8}$/.test(np.tax_id.trim())) return flash('統編要 8 碼數字');
    const { error } = await supabase.from('payee_presets').insert({
      label: np.label.trim() || np.company.trim() || account,
      bank_code: np.bank_code.trim() || null, account,
      company: np.company.trim() || null, tax_id: np.tax_id.trim() || null, sort: 50,
    });
    // 23505 = 帳號重複。訊息要講出是哪一個欄位撞到,否則使用者會以為是別的問題
    if (error) return flash(error.code === '23505'
      ? `帳號 ${account} 已經建過了（可能是停用中的那筆,把它啟用即可）` : '新增失敗:' + error.message);
    setNp({ label: '', bank_code: '', account: '', company: '', tax_id: '' });
    flash('已新增'); loadPayees();
  }
  async function updPayee(id: string, patch: Partial<Payee>) {
    const { error } = await supabase.from('payee_presets')
      .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return flash('更新失敗:' + error.message);
    loadPayees();
  }
  async function delPayee(p: Payee) {
    // 請款單不掛外鍵（見 migration_96）,所以刪掉不會動到既有單據
    if (!confirm(`刪除常用帳號「${p.label}」?\n\n既有的請款單不受影響（那些單自己存著當初的帳號）。\n只是之後填新單時選不到它。\n\n會移到回收桶,可以復原。`)) return;
    const r = await softDelete(supabase, 'payee_presets', p.id);
    flash(r.message); if (r.ok) loadPayees();
  }

  async function addPayAccount() {
    const code = newAcctCode.trim();
    const name = newAcctName.trim() || code;
    if (!code) return flash('請填代號');
    const { error } = await supabase.from('payment_accounts').insert({
      method: newAcctMethod, code, name,
      for_income: newAcctMethod === 'transfer',   // 信用卡預設只用於付款
      for_payment: true, sort: 50,
    });
    if (error) return flash('新增失敗:' + error.message);
    setNewAcctCode(''); setNewAcctName(''); flash('已新增 ' + code); load();
  }
  async function updatePayAccount(id: string, patch: Partial<PayAccount>) {
    const { error } = await supabase.from('payment_accounts').update(patch).eq('id', id);
    if (error) return flash('更新失敗:' + error.message);
    flash('已更新'); load();
  }
  async function deletePayAccount(a: PayAccount) {
    if (!confirm(`確定刪除帳號「${a.code}」?已經記在訂單或支出上的資料不會跟著改,那些紀錄會找不到對應帳號。建議改用「停用」。\n\n會移到回收桶,可以復原。`)) return;
    const r = await softDelete(supabase, 'payment_accounts', a.id);
    flash(r.message); if (r.ok) load();
  }

  // ---- 房源 ----
  async function addProperty() {
    const name = newPropName.trim();
    if (!name || !selEstate) return;
    const { error } = await supabase.from('properties').insert({ name, estate_id: selEstate });
    if (error) return flash('新增失敗:' + error.message);
    setNewPropName(''); flash('已新增 ' + name); load();
  }
  async function updateProperty(id: string, patch: Partial<Property>) {
    const { error } = await supabase.from('properties').update(patch).eq('id', id);
    if (error) return flash('更新失敗:' + error.message);
    flash('已更新'); load();
  }
  async function deleteProperty(id: string, name: string) {
    if (!confirm(`確定刪除房源「${name}」?(訂單/評價/清潔的房源文字仍保留)\n\n會移到回收桶,可以復原。`)) return;
    const r = await softDelete(supabase, 'properties', id);
    flash(r.message); if (r.ok) load();
  }

  if (role === null) return <div className="text-gray-400 py-20 text-center">載入中…</div>;
  const isAdmin = role === 'super_admin';
  const canSee: TabKey[] = isAdmin
    ? (Object.keys(TAB_LABEL) as TabKey[])
    : role === 'accountant' ? ACCOUNTANT_TABS : [];
  if (!canSee.length) {
    return <div className="text-gray-400 py-20 text-center">此頁僅限總經理與會計</div>;
  }
  // 會計的預設分頁不能是 people（他看不到那一頁,會停在空白畫面）
  if (!canSee.includes(tab)) { setTab(canSee[0]); return null; }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <h1>權限管理</h1>
        <Toast msg={msg} />
      </div>

      <div className="flex flex-wrap gap-1 mb-5 border-b border-mor-line">
        {canSee.map((k) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === k ? 'border-mor-slate text-mor-slate' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {TAB_LABEL[k]}
          </button>
        ))}
      </div>

      {/* ===== 人員管理 ===== */}
      {tab === 'people' && (
      <section className="mb-8">
        <div className="rounded-xl glass overflow-hidden">
          {/* 手機放不下這幾欄 —— 沒有這層捲軸容器，欄位會被壓到只剩幾個 px 而不是可以滑動 */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-white/45">
                  <th className="px-4 py-2.5">姓名</th>
                  <th className="px-4 py-2.5">職位</th>
                  <th className="px-4 py-2.5">權限</th>
                  <th className="px-4 py-2.5">帳號</th>
                  <th className="px-4 py-2.5">狀態</th>
                  <th className="px-4 py-2.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id} className={`border-b border-mor-line/60 last:border-0 ${s.active ? '' : 'opacity-50'}`}>
                    <td className="px-4 py-2 font-medium">
                      <span className="group inline-flex items-center gap-1.5">
                        {s.name}{s.aliases?.length ? <span className="text-xs text-gray-400">({s.aliases.join('/')})</span> : null}
                        <button onClick={() => renameStaff(s)} title="修改姓名"
                          className="text-xs text-gray-300 hover:text-mor-slate">✎</button>
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <select value={s.staff_type} disabled={!s.active} onChange={(e) => changeStaffType(s, e.target.value)}
                        className="rounded-lg border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-100 disabled:cursor-not-allowed">
                        {TYPE_OPTS.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <span className="text-sm">{ROLE_LABEL[s.role ?? 'housekeeper'] ?? s.role}</span>
                      <span className="ml-1 text-xs text-gray-400">(依職位)</span>
                    </td>
                    <td className="px-4 py-2">
                      {s.auth_uid ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">{s.email}</span>
                          <button onClick={() => setAcct({ staffId: s.id, name: s.name, mode: 'password', email: s.email ?? '', password: '', role: s.role ?? 'housekeeper' })} className="text-xs text-mor-slate underline hover:text-mor-blue">改密碼</button>
                          <button onClick={() => deleteAccount(s)} className="text-xs text-red-500 underline hover:text-red-600">刪除帳號</button>
                        </div>
                      ) : (
                        <button onClick={() => setAcct({ staffId: s.id, name: s.name, mode: 'create', email: `u${s.id.slice(0, 8)}@justwork.estia.com.tw`, password: '', role: s.role ?? 'housekeeper' })} className="text-xs text-mor-blue underline">建立登入</button>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${s.active ? 'bg-mor-greenlight text-mor-green' : 'bg-gray-100 text-gray-400'}`}>
                        {s.active ? '在職' : '離職'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button onClick={() => toggleActive(s)}
                        className="text-xs text-mor-slate underline hover:text-mor-blue">
                        {s.active ? '設為離職' : '恢復在職'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 px-4 py-3 border-t border-mor-line bg-mor-sand/20 text-sm">
            <input value={newStaffName} onChange={(e) => setNewStaffName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addStaff(); }}
              placeholder="新人員姓名" className="rounded-lg border border-gray-300 px-2 py-1.5 w-40" />
            <select value={newStaffType} onChange={(e) => setNewStaffType(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
              {TYPE_OPTS.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
            <button onClick={addStaff} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增人員</button>
          </div>
        </div>
        {orphanAccounts.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
            <div className="font-medium text-amber-800 mb-1">有 {orphanAccounts.length} 個登入帳號未對應到人員名冊</div>
            <ul className="text-xs text-amber-700 space-y-0.5">
              {orphanAccounts.map((p) => (
                <li key={p.id}>{p.name || '(未命名)'} · {ROLE_LABEL[p.role] ?? p.role}</li>
              ))}
            </ul>
            <p className="text-xs text-amber-600 mt-1.5">這些帳號可以登入,但無法在此頁編輯。請執行補建 SQL(migration_31)。</p>
          </div>
        )}
        <p className="text-xs text-gray-400 mt-2">停用=離職:紀錄保留、可查詢,但從統計列表排除;總數仍計入營運總量。離職會同時停用網站登入(封鎖帳號),恢復在職則解除。權限由職位自動決定,不能單獨改:管家/房務→一般、經理→主管、會計→會計、總經理→super admin。各權限看得到的頁面:總經理=全部含設定;主管=營收/評價/清潔/訂單/請款/支出;會計=營收/請款/支出;一般=清潔/評價/訂單/請款。只有職位「管家」會出現在物業負責人下拉。</p>
      </section>
      )}

      {/* ===== 物業與負責人 ===== */}
      {tab === 'estates' && (
      <section>
        <div className="rounded-xl glass overflow-hidden">
          {/* 手機放不下這幾欄 —— 沒有這層捲軸容器，欄位會被壓到只剩幾個 px 而不是可以滑動 */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-white/45">
                  <th className="px-4 py-2.5">物業</th>
                  <th className="px-4 py-2.5">負責管家</th>
                  <th className="px-4 py-2.5 w-20">排序</th>
                  <th className="px-4 py-2.5">狀態</th>
                  <th className="px-4 py-2.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {estates.map((e) => (
                  <tr key={e.id} className={`border-b border-mor-line/60 last:border-0 ${e.active ? '' : 'opacity-50'}`}>
                    <td className="px-4 py-2 font-medium">{e.name}</td>
                    <td className="px-4 py-2">
                      <select value={e.manager ?? ''} disabled={!e.active} onChange={(ev) => updateEstate(e.id, { manager: ev.target.value || null })}
                        className="rounded-lg border border-gray-300 px-2 py-1 text-sm min-w-24 disabled:bg-gray-100">
                        <option value="">未指派</option>
                        {activeHousekeepers.map((h) => <option key={h.id} value={h.name}>{h.name}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <input type="number" defaultValue={e.sort} onBlur={(ev) => { const v = parseInt(ev.target.value); if (v !== e.sort) updateEstate(e.id, { sort: v }); }}
                        className="rounded-lg border border-gray-300 px-2 py-1 w-16 text-sm" />
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${e.active ? 'bg-mor-greenlight text-mor-green' : 'bg-gray-100 text-gray-400'}`}>{e.active ? '啟用' : '停用'}</span>
                    </td>
                    <td className="px-4 py-2 text-right space-x-3">
                      <button onClick={() => updateEstate(e.id, { active: !e.active })} className="text-xs text-mor-slate underline hover:text-mor-blue">{e.active ? '停用' : '啟用'}</button>
                      <button onClick={() => deleteEstate(e.id, e.name)} className="text-xs text-red-500 underline hover:text-red-700">刪除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 px-4 py-3 border-t border-mor-line bg-mor-sand/20 text-sm">
            <input value={newEstateName} onChange={(e) => setNewEstateName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addEstate(); }}
              placeholder="新物業名稱" className="rounded-lg border border-gray-300 px-2 py-1.5 w-40" />
            <button onClick={addEstate} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增物業</button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-2">停用物業:不顯示在評價/清潔的評分與篩選、也不需指派(紀錄仍保留)。負責管家換人後,該物業所有評價(含過去)歸現任。排序越小越前。</p>
      </section>
      )}

      {/* ===== 收付款帳號 ===== */}
      {tab === 'accounts' && (
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">收付款帳號</h2>
        <div className="rounded-xl glass overflow-hidden">
          {/* 手機放不下這幾欄 —— 沒有這層捲軸容器，欄位會被壓到只剩幾個 px 而不是可以滑動 */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-white/45">
                  <th className="px-4 py-2.5">方式</th>
                  <th className="px-4 py-2.5">代號</th>
                  <th className="px-4 py-2.5">顯示名稱</th>
                  <th className="px-4 py-2.5 text-center">可收款</th>
                  <th className="px-4 py-2.5 text-center">可付款</th>
                  <th className="px-4 py-2.5 w-20">排序</th>
                  <th className="px-4 py-2.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {payAccounts.map((a) => (
                  <tr key={a.id} className={`border-b border-mor-line/60 last:border-0 ${a.active ? '' : 'opacity-50'}`}>
                    <td className="px-4 py-2">{METHOD_LABEL[a.method] ?? a.method}</td>
                    <td className="px-4 py-2 font-medium">{a.code}</td>
                    <td className="px-4 py-2">
                      <input defaultValue={a.name}
                        onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== a.name) updatePayAccount(a.id, { name: v }); }}
                        className="rounded-lg border border-gray-300 px-2 py-1 w-44" />
                    </td>
                    <td className="px-4 py-2 text-center">
                      <input type="checkbox" checked={a.for_income} className="w-4 h-4"
                        onChange={(e) => updatePayAccount(a.id, { for_income: e.target.checked })} />
                    </td>
                    <td className="px-4 py-2 text-center">
                      <input type="checkbox" checked={a.for_payment} className="w-4 h-4"
                        onChange={(e) => updatePayAccount(a.id, { for_payment: e.target.checked })} />
                    </td>
                    <td className="px-4 py-2">
                      <input type="number" defaultValue={a.sort}
                        onBlur={(e) => { const v = parseInt(e.target.value); if (v !== a.sort) updatePayAccount(a.id, { sort: v }); }}
                        className="rounded-lg border border-gray-300 px-2 py-1 w-16 text-sm" />
                    </td>
                    <td className="px-4 py-2 text-right space-x-3">
                      <button onClick={() => updatePayAccount(a.id, { active: !a.active })} className="text-xs text-mor-slate underline hover:text-mor-blue">{a.active ? '停用' : '啟用'}</button>
                      <button onClick={() => deletePayAccount(a)} className="text-xs text-red-500 underline hover:text-red-700">刪除</button>
                    </td>
                  </tr>
                ))}
                {payAccounts.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">尚無帳號</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-mor-line bg-mor-sand/20 text-sm">
            <select value={newAcctMethod} onChange={(e) => setNewAcctMethod(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
              <option value="transfer">匯款</option>
              <option value="credit_card">信用卡</option>
            </select>
            <input value={newAcctCode} onChange={(e) => setNewAcctCode(e.target.value)} placeholder="代號(如 8088)"
              className="rounded-lg border border-gray-300 px-2 py-1.5 w-32" />
            <input value={newAcctName} onChange={(e) => setNewAcctName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addPayAccount(); }}
              placeholder="顯示名稱(如 元大 8088)" className="rounded-lg border border-gray-300 px-2 py-1.5 w-44" />
            <button onClick={addPayAccount} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增帳號</button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          支付方式(現金/匯款/信用卡/加密貨幣)是固定的,這裡管的是匯款與信用卡底下的帳號。
          「可收款」決定它出不出現在短租與契約的入款選單;「可付款」決定它出不出現在請款與支出。
          <b>代號一旦有交易掛上就不要再改</b> —— 訂單與支出存的是代號,改了舊資料會對不到,要調整標示請改顯示名稱。不再使用的帳號請用「停用」而非刪除。
        </p>
      </section>
      )}

      {/* ===== 房源管理 ===== */}
      {/*
        常用帳號（migration_96）。
        每開一張匯款請款單都要重打銀行代碼／帳號／戶名／統編 ——
        打錯的代價是錢匯到別的帳戶，而且不會有任何跡象，要等對方說沒收到才知道。
      */}
      {tab === 'payees' && (
      <section className="mb-8">
        <div className="rounded-xl glass overflow-hidden">
          <div className="px-4 py-2.5 border-b border-mor-line bg-white/45 text-sm font-medium">
            常用收款對象（廠商帳號）
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-mor-line">
                  <th className="px-4 py-2.5">顯示名</th>
                  <th className="px-4 py-2.5">銀行代碼</th>
                  <th className="px-4 py-2.5">帳號</th>
                  <th className="px-4 py-2.5">戶名</th>
                  <th className="px-4 py-2.5">統編</th>
                  <th className="px-4 py-2.5 w-20">排序</th>
                  <th className="px-4 py-2.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {payees.map((p) => (
                  <tr key={p.id} className={`border-b border-mor-line/60 last:border-0 ${p.active ? '' : 'opacity-50'}`}>
                    {([['label', 22], ['bank_code', 10], ['account', 20], ['company', 22], ['tax_id', 10]] as const).map(([k, w]) => (
                      <td key={k} className="px-4 py-2">
                        <input defaultValue={(p[k] as string) ?? ''} style={{ width: `${w}ch` }}
                          onBlur={(e) => { const v = e.target.value.trim();
                            if (v !== ((p[k] as string) ?? '')) updPayee(p.id, { [k]: v || null } as Partial<Payee>); }}
                          className="rounded border border-mor-line px-2 py-1 text-sm" />
                      </td>
                    ))}
                    <td className="px-4 py-2">
                      <input type="number" defaultValue={p.sort} className="w-16 rounded border border-mor-line px-2 py-1 text-sm"
                        onBlur={(e) => { const v = Number(e.target.value) || 0;
                          if (v !== p.sort) updPayee(p.id, { sort: v }); }} />
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <button onClick={() => updPayee(p.id, { active: !p.active })}
                        className="text-xs text-mor-blue underline mr-3">{p.active ? '停用' : '啟用'}</button>
                      <button onClick={() => delPayee(p)} className="text-xs text-red-500 underline">刪除</button>
                    </td>
                  </tr>
                ))}
                {!payees.length && (
                  <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-gray-400">
                    還沒有常用帳號。用下面那排欄位新增第一筆。
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-3 border-t border-mor-line flex flex-wrap items-end gap-2">
            {([['label', '顯示名'], ['bank_code', '銀行代碼'], ['account', '帳號 *'],
               ['company', '戶名'], ['tax_id', '統編']] as const).map(([k, lb]) => (
              <label key={k} className="flex flex-col gap-1">
                <span className="text-xs text-gray-500">{lb}</span>
                <input value={np[k]} onChange={(e) => setNp({ ...np, [k]: e.target.value })}
                  className="rounded-lg border border-mor-line px-2 py-1.5 text-sm w-32" />
              </label>
            ))}
            <button onClick={addPayee}
              className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark">
              + 新增
            </button>
          </div>
        </div>
      </section>
      )}

      {tab === 'props' && (
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">房源管理</h2>
        <div className="flex items-center gap-2 mb-2 text-sm">
          <span className="text-xs text-gray-500">物業</span>
          <select value={selEstate} onChange={(e) => setSelEstate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}{e.active ? '' : '(停用)'}</option>)}
          </select>
          <span className="text-xs text-gray-400">共 {properties.filter((p) => p.estate_id === selEstate).length} 間</span>
        </div>
        <div className="rounded-xl glass overflow-hidden">
          {/* 手機放不下這幾欄 —— 沒有這層捲軸容器，欄位會被壓到只剩幾個 px 而不是可以滑動 */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-white/45">
                  <th className="px-4 py-2.5">房源名稱(點擊可改名)</th>
                  <th className="px-4 py-2.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {properties.filter((p) => p.estate_id === selEstate).map((p) => (
                  <tr key={p.id} className="border-b border-mor-line/60 last:border-0">
                    <td className="px-4 py-2">
                      <input defaultValue={p.name} onBlur={(ev) => { const v = ev.target.value.trim(); if (v && v !== p.name) updateProperty(p.id, { name: v }); }}
                        className="rounded-lg border border-gray-300 px-2 py-1 w-64" />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button onClick={() => deleteProperty(p.id, p.name)} className="text-xs text-red-500 underline hover:text-red-700">刪除</button>
                    </td>
                  </tr>
                ))}
                {properties.filter((p) => p.estate_id === selEstate).length === 0 && (
                  <tr><td colSpan={2} className="px-4 py-6 text-center text-gray-400">此物業尚無房源</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 px-4 py-3 border-t border-mor-line bg-mor-sand/20 text-sm">
            <input value={newPropName} onChange={(e) => setNewPropName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addProperty(); }}
              placeholder="新房源名稱" className="rounded-lg border border-gray-300 px-2 py-1.5 w-40" />
            <button onClick={addProperty} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增房源</button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-2">直接點房源名稱即可改名(改完點空白處儲存)。改名不影響已連結的訂單/評價(用 ID 綁定)。</p>
      </section>
      )}

      {/* ===== 同步建議 ===== */}
      {/*
        【為什麼差異要獨立一個分頁,不併進編輯紀錄】
        編輯紀錄是流水帳:每一列都是「當時發生了什麼」,永遠留著。
        而差異是待辦:同一個房源不一致在對照表修好之前每天都會再出現一次,
        當成流水帳存的話一週後同一個問題有七列,看不出哪一列還算數。

        所以這裡的清單是「現在還沒解決的」—— 修好之後隔天自己消失。
        清單空了就代表真的沒事了,那是流水帳給不了的保證。
      */}
      {tab === 'sync' && (
      <section className="space-y-5">
        {/* ── 分級規則 ─────────────────────────── */}
        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">爬蟲會動哪些欄位</h2>
          <div className="rounded-xl glass overflow-hidden">
            {SYNC_TIERS.map((t) => (
              <div key={t.level} className="border-b border-mor-line/50 last:border-0 px-4 py-3 sm:flex sm:gap-4">
                <div className="sm:w-36 shrink-0 mb-1 sm:mb-0">
                  <span className={`inline-block rounded px-2 py-0.5 text-[11px] whitespace-nowrap ${t.tone}`}>
                    {t.level}
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{t.fields}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{t.why}</div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-2">
            比對的鑰匙是 <b>Airbnb 確認碼</b>,不是姓名或日期 —— 那些會變,一變就會產生重複訂單。
            2026-07 就發生過:同一筆因為房客改名變成兩列,當月營收多算 33,053。
          </p>
        </div>

        {/* ── 待處理 ───────────────────────────── */}
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold text-gray-700">還沒處理的差異</h2>
            <span className="text-xs text-gray-400">共 {issues.length} 筆</span>
            <div className="flex-1" />
            <button onClick={loadSync}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">重新整理</button>
          </div>

          {issues.length === 0 ? (
            <div className="rounded-xl glass px-4 py-10 text-center text-sm text-gray-400">
              沒有待處理的差異。<br />
              <span className="text-xs">這份清單每次同步會整批換掉 —— 空的就代表爬蟲跟系統對得起來。</span>
            </div>
          ) : (
            <div className="space-y-3">
              {Object.entries(issueGroups).map(([field, list]) => (
                <div key={field} className="rounded-xl glass overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-mor-line bg-white/45">
                    <div className="text-sm font-medium">{field} <span className="text-gray-400 font-normal">· {list.length} 筆</span></div>
                    {ISSUE_ADVICE[field] && (
                      <div className="text-xs text-gray-500 mt-0.5">{ISSUE_ADVICE[field]}</div>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[620px] text-sm">
                      <thead>
                        <tr className="text-left text-xs text-gray-500 border-b border-mor-line/60">
                          <th className="px-4 py-2">編號</th>
                          <th className="px-4 py-2">現在是</th>
                          <th className="px-4 py-2">爬蟲認為</th>
                          <th className="px-4 py-2 whitespace-nowrap">listing_id</th>
                          <th className="px-4 py-2 whitespace-nowrap">第一次出現</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((it) => (
                          <tr key={it.kind + it.code + it.field} className="border-b border-mor-line/40 last:border-0">
                            <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">{it.code}</td>
                            <td className="px-4 py-2 text-gray-500">{it.from_val ?? '—'}</td>
                            <td className="px-4 py-2 font-medium">
                              {it.to_val ?? '—'}
                              {/* 這個 listing 目前只對到某個停用房源 —— 那通常就是元兇 */}
                              {typeof it.extra?.['停用對照'] === 'string' && (
                                <span className="ml-1 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800 whitespace-nowrap">
                                  停用:{String(it.extra['停用對照'])}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2 font-mono text-[11px] text-gray-400 whitespace-nowrap">{it.listing_id ?? '—'}</td>
                            {/* 放多久了。同一個問題掛了兩週的話,那不是「還沒處理」,是被忽略了 */}
                            <td className="px-4 py-2 text-xs text-gray-400 whitespace-nowrap">{it.first_seen?.slice(0, 10)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── 流水帳 ───────────────────────────── */}
        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">最近幾次同步</h2>
          <div className="rounded-xl glass overflow-x-auto">
            {runs.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-gray-400">
                還沒有同步紀錄。這張表從 migration_113 之後才開始累積。
              </div>
            ) : (
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-white/45">
                    <th className="px-4 py-2.5 whitespace-nowrap">時間</th>
                    <th className="px-4 py-2.5">來源</th>
                    <th className="px-4 py-2.5 text-right">抓到</th>
                    <th className="px-4 py-2.5 text-right">新增</th>
                    <th className="px-4 py-2.5 text-right">更新</th>
                    <th className="px-4 py-2.5 text-right">作廢</th>
                    <th className="px-4 py-2.5">差異</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-b border-mor-line/50 last:border-0 align-top">
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-gray-500">
                        {twTime(r.at)}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">{r.kind === 'orders' ? '訂單' : r.kind === 'reviews' ? '評價' : r.kind}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-gray-500">{r.received}</td>
                      {/* 新增為 0 是常態,亮起來的才值得看一眼 */}
                      <td className={`px-4 py-2 text-right tabular-nums ${r.inserted ? 'font-medium text-mor-green' : 'text-gray-300'}`}>{r.inserted}</td>
                      <td className={`px-4 py-2 text-right tabular-nums ${r.updated ? '' : 'text-gray-300'}`}>{r.updated}</td>
                      <td className={`px-4 py-2 text-right tabular-nums ${r.voided ? 'text-red-600' : 'text-gray-300'}`}>{r.voided}</td>
                      <td className="px-4 py-2 text-xs text-gray-500">
                        {Object.entries(r.detail ?? {}).filter(([, v]) => v > 0)
                          .map(([k, v]) => `${k} ${v}`).join('、') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-2">
            訂單每天 06:06、評價每天 06:37 各跑一次。
            「抓到」是 Airbnb 回了幾筆,大部分都沒有變化 —— <b>新增與作廢那兩欄才是真的動到資料</b>。
            某天新增突然變成兩位數的話值得查一下,那通常代表對照表剛被修好、一批卡住的訂單一次進來。
          </p>
        </div>
      </section>
      )}

      {/* ===== 編輯紀錄 ===== */}
      {tab === 'audit' && (
      <section>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <select value={auditTable} onChange={(e) => setAuditTable(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            <option value="">全部資料</option>
            {Object.entries(AUDIT_TABLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {/* 預設只看人工 —— 這張表回答的是「誰改了什麼」,那個問題問的是人 */}
          <select value={auditWho} onChange={(e) => setAuditWho(e.target.value as '' | 'human' | 'auto')}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            <option value="human">只看人工操作</option>
            <option value="auto">只看爬蟲／系統</option>
            <option value="">全部</option>
          </select>
          <button onClick={loadAudit} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">重新整理</button>
          <span className="text-xs text-gray-400">最近 300 筆</span>
        </div>

        <div className="rounded-xl glass overflow-x-auto">
          {audits.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-gray-400">
              目前沒有紀錄。這張表從 migration_72 之後才開始累積,在那之前的改動查不到。
            </div>
          ) : (
            /* 外層那個 div 已經有 overflow-x-auto。min-w 是關鍵 ——
               沒有它，w-full 的表格會乖乖縮到 100%，欄位被壓到剩幾個 px 而永遠不觸發捲軸 */
            <div>
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-white/45">
                    <th className="px-4 py-2.5 whitespace-nowrap">時間</th>
                    <th className="px-4 py-2.5">操作人</th>
                    <th className="px-4 py-2.5">資料</th>
                    <th className="px-4 py-2.5">對象</th>
                    <th className="px-4 py-2.5">動作</th>
                    <th className="px-4 py-2.5">改了什麼</th>
                  </tr>
                </thead>
                <tbody>
                  {audits.map((a) => (
                    <tr key={a.id} className="border-b border-mor-line/50 last:border-0 align-top">
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-gray-500">
                        {twTime(a.at)}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {a.user_id
                          ? (nameOfUser[a.user_id] ?? <span className="text-xs text-gray-400">已刪除的帳號</span>)
                          : <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">爬蟲／系統</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                        {AUDIT_TABLE[a.table_name] ?? a.table_name}
                      </td>
                      <td className="px-4 py-2 font-medium">{a.label ?? '—'}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap ${
                          a.action === 'delete' ? 'bg-red-50 text-red-600'
                          : a.action === 'insert' ? 'bg-mor-greenlight text-mor-green'
                          : 'bg-mor-bluelight text-mor-slate'}`}>
                          {AUDIT_ACTION[a.action] ?? a.action}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {a.action === 'update' && a.changes
                          ? Object.entries(a.changes as Record<string, any>)
                              .filter(([k]) => !AUDIT_SKIP.has(k))
                              .map(([k, v]) => (
                                <div key={k} className="whitespace-nowrap">
                                  <span className="text-gray-400">{k}</span>{' '}
                                  <span className="text-gray-500">{JSON.stringify(Array.isArray(v) ? v[0] : null)}</span>
                                  {' → '}
                                  <span className="font-medium">{JSON.stringify(Array.isArray(v) ? v[1] : v)}</span>
                                </div>
                              ))
                          : <span className="text-gray-400">整筆{AUDIT_ACTION[a.action] ?? a.action}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <p className="text-xs text-gray-400 mt-2">
          記錄支出、請款單、押金、訂單、契約與評價的異動。<b>刪除與新增存整列</b>（刪掉的資料還原得回來）,<b>修改只存變動的欄位</b>。
          爬蟲<b>新增</b>的訂單與評價也記（每天個位數,用上面的篩選分開看）;
          爬蟲<b>修改</b>的不記 —— 那是每天幾百筆的來源,改了什麼在「同步建議」分頁看。
          <b>刪除一律記</b>,不管是誰做的;只有契約重產月租單的連帶增刪跳過,那是系統在算不是人在決定。
        </p>
      </section>
      )}

      {acct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between">{acct.mode === 'create' ? `建立登入帳號 · ${acct.name}` : `更換密碼 · ${acct.name}`}<button onClick={() => setAcct(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button></div>
            <div className="px-6 py-4 flex flex-col gap-3 text-sm">
              {acct.mode === 'create' && (
                <>
                  <label className="flex flex-col gap-1">登入 email<input value={acct.email} onChange={(e) => setAcct({ ...acct, email: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" placeholder="name@justwork.estia.com.tw" /></label>
                  <div className="flex flex-col gap-1">權限<div className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-gray-600">{ROLE_LABEL[acct.role] ?? acct.role}<span className="ml-1 text-xs text-gray-400">(依職位自動決定)</span></div></div>
                </>
              )}
              <label className="flex flex-col gap-1">{acct.mode === 'create' ? '設定密碼' : '新密碼'}(至少 6 碼)<input type="text" value={acct.password} onChange={(e) => setAcct({ ...acct, password: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" placeholder="輸入密碼" autoComplete="new-password" /></label>
              <p className="text-xs text-gray-400">密碼由你設定;人員用此 email + 密碼登入。之後可在此更換。</p>
            </div>
            <div className="border-t border-mor-line px-6 py-3 flex justify-end gap-2">
              <button onClick={() => setAcct(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={saveAcct} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark">{acct.mode === 'create' ? '建立帳號' : '更換密碼'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
