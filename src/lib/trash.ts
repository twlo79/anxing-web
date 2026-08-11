/**
 * 回收桶的顯示邏輯（純函式）。
 *
 * 表名的中文對照在資料庫也有一份（trash_table_label）——
 * 兩邊都需要：SQL 那份給查詢結果用，這份給畫面用。
 * **加新表時兩邊都要加**，只加一邊的話其中一處會直接顯示英文表名。
 */

export const TABLE_LABEL: Record<string, string> = {
  orders: '訂單',
  contracts: '契約',
  expenses: '支出',
  purchase_requests: '請款單',
  purchase_request_items: '請款項目',
  deposits: '押金',
  invoices: '發票',
  order_payments: '訂單收款',
  contract_payments: '契約期款',
  attachments: '憑證',
  revenue_recognitions: '營收認列',
  contract_recurring_charges: '固定加費',
  recurring_charges: '定期收費',
  reviews: '評價',
  estates: '物業',
  properties: '房源',
  payment_accounts: '收付款帳號',
  payee_presets: '常用帳號',
  customers: '客戶',
  announcements: '公告',
  hk_work_item: '房務排班',
  hk_event: '房務事件',
  cleaning_records: '清潔記錄',
  announcement_reads: '公告已讀',
  staff_properties: '管家負責房源',
};

/**
 * 這筆放多久了。
 *
 * 【為什麼只標註不自動刪】（使用者指定）
 * 自動刪除是一個沒有人盯著的毀滅動作 —— 一年後才發現已經來不及。
 * 標註「放了 4 個月」讓人自己決定，成本是回收桶會長大，
 * 而那個成本遠低於「東西在沒有人看的情況下消失」。
 */
export function trashAge(deletedAt: string, now: Date = new Date()): { days: number; old: boolean; text: string } {
  const d = new Date(deletedAt);
  if (Number.isNaN(d.getTime())) return { days: 0, old: false, text: '' };
  const days = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86400000));
  if (days >= 365) return { days, old: true, text: `放了 ${Math.floor(days / 365)} 年多` };
  if (days >= 30) return { days, old: true, text: `放了 ${Math.floor(days / 30)} 個月` };
  return { days, old: false, text: `${days} 天前` };
}

/** 這些欄位對「看這筆是什麼」沒有幫助，藏起來 —— 留著只會把真正的內容擠下去 */
const HIDE = new Set([
  'id', 'created_at', 'updated_at', 'search_tsv',
  'fx_revenue', 'fx_deposit', 'concessions', 'detail_comments',
  'estate_key', 'prop_key', 'name_key',
]);

/**
 * 整列 jsonb → [欄位, 值][]，給畫面逐列顯示。
 *
 * 【空值一律不顯示】
 * 一張 orders 有四十幾欄，大部分是 null。全部列出來的話真正有內容的
 * 那五欄會被埋在中間，等於沒有顯示。
 */
export function fieldRows(data: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(data ?? {})) {
    if (HIDE.has(k)) continue;
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    out.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
  }
  return out;
}

/* ============================================================
 * 前端呼叫用
 * ============================================================ */

type Rpc = {
  rpc: (fn: string, args: Record<string, unknown>) =>
    PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/**
 * 刪除 = 移到回收桶。
 *
 * 【什麼時候用這支，什麼時候還是用 .delete()】
 *
 * 用這支：**使用者按了「刪除」**。訂單、契約、支出、請款單、發票、
 * 收款紀錄、憑證、設定主檔 —— 刪錯了要救得回來。
 *
 * 不要用這支：**系統為了重新產生而先清掉的那些**。
 * 例如重建整期排班、移房重組子單、請款項目重存、遞延子單重算。
 * 那些每存一次檔就會塞幾十筆進回收桶，把真正的刪除淹掉 ——
 * 而回收桶一旦被雜訊淹掉，就沒有人會再打開它。
 */
export async function softDelete(
  supabase: Rpc, table: string, id: string, reason?: string,
): Promise<{ ok: boolean; message: string; trashId?: string }> {
  const { data, error } = await supabase.rpc('soft_delete', {
    p_table: table, p_id: id, p_reason: reason ?? null,
  });
  if (error) return { ok: false, message: '刪除失敗：' + error.message };
  const r = data as { ok?: boolean; message?: string; trash_id?: string } | null;
  // RPC 沒回東西是不該發生的 —— 但比起靜靜當成成功，講出來比較好
  if (!r || typeof r.ok !== 'boolean') {
    return { ok: false, message: '刪除失敗：資料庫沒有回應，請重新整理確認狀態。' };
  }
  return {
    ok: r.ok,
    message: r.message ?? (r.ok ? '已移到回收桶' : '刪除失敗'),
    trashId: r.trash_id,
  };
}

/** 從回收桶救回來。畫面上的「復原」與刪除後的即時 undo 都走這支。 */
export async function restoreTrash(
  supabase: Rpc, trashId: string,
): Promise<{ ok: boolean; message: string }> {
  const { data, error } = await supabase.rpc('restore_trash', { p_trash: trashId });
  if (error) return { ok: false, message: '復原失敗：' + error.message };
  const r = data as { ok?: boolean; message?: string } | null;
  if (!r || typeof r.ok !== 'boolean') {
    return { ok: false, message: '復原失敗：資料庫沒有回應，請重新整理確認狀態。' };
  }
  return { ok: r.ok, message: r.message ?? (r.ok ? '已復原' : '復原失敗') };
}
