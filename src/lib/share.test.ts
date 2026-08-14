import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stageOf, missingVotes, buildShareText,
  depositShareText, requestShareText,
  type ShareDep, type ShareReq,
} from './share.ts';

const O = 'https://justwork.estia.com.tw';

const req = (p: Partial<ShareReq> = {}): ShareReq => ({
  req_no: 'PR-2608-001', status: 'pending', total_amount: 20800,
  manager_approved_at: null, admin_approved_at: null, ...p,
});
const dep = (p: Partial<ShareDep> = {}): ShareDep => ({
  id: 'd1', room: '14B3', guest_name: '楊翠元', amount: 100000,
  payee_name: '楊翠元', payee_bank_code: '822', payee_account: '1234567',
  planned_refund_on: '2026-08-20', refund_status: 'pending', ...p,
});

/* ── 階段 ────────────────────────────────────── */

test('★★ 付過款的單不算「已核可」', () => {
  // 資料庫裡付過款的單狀態仍然是 approved，只是多了出款日。
  // 不分開的話,錢已經匯出去的單分享出去會寫「已核可」,看起來像還在等會計
  assert.equal(stageOf('approved', true), 'paid');
  assert.equal(stageOf('approved', false), 'approved');
});

test('駁回與草稿', () => {
  assert.equal(stageOf('rejected', false), 'rejected');
  assert.equal(stageOf('draft', false), 'draft');
  assert.equal(stageOf(null, false), 'draft', '押金沒送審時 refund_status 是 null');
  assert.equal(stageOf('none', false), 'draft');
});

test('沒看過的狀態當作待核可 —— 寧可多叫一次也不要說成已通過', () => {
  assert.equal(stageOf('pending', false), 'pending');
  assert.equal(stageOf('whatever', false), 'pending');
});

/* ── 還缺誰 ──────────────────────────────────── */

test('★ 只講缺的人,不講已經簽的', () => {
  // 收到訊息的人要判斷「這件事卡在我身上嗎」——
  // 列出已簽的人他還要自己反推
  assert.equal(missingVotes(null, null), '主管、總經理核可');
  assert.equal(missingVotes('2026-08-10T00:00:00Z', null), '總經理核可');
  assert.equal(missingVotes(null, '2026-08-10T00:00:00Z'), '主管核可');
});

test('兩票都到就沒有缺的', () => {
  assert.equal(missingVotes('a', 'b'), '');
});

/* ── 組訊息 ──────────────────────────────────── */

test('★ 空欄位整行不出現', () => {
  // 「收款人　—」比沒有那一行更難讀:讀的人得先確認那個破折號不是資料
  const t = buildShareText({
    icon: '🧾', kind: '請款單', stage: 'pending', headline: 'X',
    amount: 100, rows: [['有', '值'], ['無', ''], ['空白', '  '], ['沒給', null]],
    url: 'u',
  });
  assert.match(t, /有/);
  assert.ok(!t.includes('無'), '空字串那行要整行消失');
  assert.ok(!t.includes('空白'));
  assert.ok(!t.includes('沒給'));
});

test('金額有千分位', () => {
  assert.match(requestShareText(req({ total_amount: 1066685 }), O), /NT\$ 1,066,685/);
});

/* ── 請款單 ──────────────────────────────────── */

test('★★ 待核可時說「待核可」並指出卡在誰身上', () => {
  const t = requestShareText(req({ manager_approved_at: '2026-08-10T00:00:00Z' }), O,
    { requester: '會計', items: '洗床單費用', payment: '匯款' });
  assert.match(t, /請款單・待核可/);
  assert.match(t, /還缺[　]+總經理核可/);
  assert.match(t, /請款者[　]+會計/);
});

test('★★ 已核可的單不再叫人去核可', () => {
  // 改版前不管什麼狀態都寫「前往核可」—— 收到的人會點進去找一顆不存在的按鈕
  const t = requestShareText(req({ status: 'approved' }), O);
  assert.match(t, /已核可・待付款/);
  assert.ok(!t.includes('前往核可'));
  assert.ok(!t.includes('還缺'), '已核可就沒有缺誰的問題');
});

test('★★ 用語對非主管也讀得懂', () => {
  // 使用者說的:「不一定只給主管」。轉給申請人、會計、廠商都很常見,
  // 「前往核可」對他們是一句看不懂的話
  for (const s of ['pending', 'approved', 'rejected', 'draft']) {
    const t = requestShareText(req({ status: s }), O);
    assert.match(t, /開啟單據/, `${s} 的動作行要中性`);
    assert.ok(!t.includes('前往核可'), `${s} 不該叫人核可`);
  }
});

test('已付款顯示付款日,不顯示預計日', () => {
  const t = requestShareText(
    req({ status: 'approved', purchased_on: '2026-08-12', planned_transfer_on: '2026-08-20' }), O);
  assert.match(t, /請款單・已付款/);
  assert.match(t, /付款日[　]+08\/12/);
  assert.ok(!t.includes('預計付款'), '兩個日期同時出現會讓人不確定哪個算數');
});

test('駁回要帶原因 —— 只說被退回等於什麼都沒說', () => {
  const t = requestShareText(req({ status: 'rejected', reject_reason: '缺發票' }), O);
  assert.match(t, /已駁回/);
  assert.match(t, /駁回原因[　]+缺發票/);
});

test('連結帶單號,對方點開直接跳到那張單', () => {
  assert.match(requestShareText(req(), O), /\/purchases\?req=PR-2608-001/);
});

/* ── 押金退款 ────────────────────────────────── */

test('★ 押金的請款者跟清單上是同一個人', () => {
  // 清單的「請款者」欄位用 refund_requested_by,訊息裡也要是同一個 ——
  // 不一致的話收到的人會以為是兩筆
  const t = depositShareText(dep(), O, '書瑜');
  assert.match(t, /請款者[　]+書瑜/);
  assert.match(t, /押金退款・待核可/);
  assert.match(t, /14B3　楊翠元/);
});

test('★ 押金與請款單用同一套狀態用語', () => {
  const a = depositShareText(dep({ refund_status: 'approved' }), O);
  const b = requestShareText(req({ status: 'approved' }), O);
  assert.match(a, /已核可・待付款/);
  assert.match(b, /已核可・待付款/);
});

test('已退款的押金顯示匯出日', () => {
  const t = depositShareText(
    dep({ refund_status: 'approved', returned_on: '2026-08-21' }), O);
  assert.match(t, /押金退款・已付款/);
  assert.match(t, /匯出日[　]+08\/21/);
});

test('帳號沒填就不出現那一行', () => {
  const t = depositShareText(dep({ payee_bank_code: null, payee_account: null }), O);
  assert.ok(!t.includes('帳號'));
});

test('連結指向請款頁而不是押金頁 —— 核可統一在那裡做', () => {
  assert.match(depositShareText(dep(), O), /\/purchases\?dep=d1/);
});
