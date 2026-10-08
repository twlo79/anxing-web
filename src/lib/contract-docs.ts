/**
 * 契約文件（PDF）的規則（migration_324，2026-10-08 David 過審）。
 *
 *   · 掛在 attachments.contract_id，檔案在 receipts bucket 的 ct/{contract_id}/…
 *   · 一份契約可以有好幾份，每份標類型：原約／展延／附約／其他
 *   · 主管、會計、總經理看得到也傳得上去；管家看不到（契約有身分證字號，是個資）
 *
 * ★ DOC_KINDS 的字串跟資料庫 att_doc_kind_chk 同步 —— 改一邊要改另一邊。
 */

export const DOC_KINDS = ['原約', '展延', '附約', '其他'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** storage 路徑前綴（RECEIPT_COL 的 ct） */
export const CONTRACT_DOC_PREFIX = 'ct';
export const CONTRACT_DOC_MAX = 10 * 1024 * 1024;   // 跟 receipts bucket 上限一樣

export type ContractDoc = {
  id: string; contract_id: string; path: string; file_name: string | null;
  doc_kind: string | null; size_bytes: number | null; created_at: string;
};

/** 誰看得到契約文件 —— 跟 can_see_receipt 預設那條一致 */
export function canSeeContractDocs(role: string | null | undefined): boolean {
  return role === 'accountant' || role === 'manager' || role === 'super_admin';
}

export function docPath(contractId: string, uuid: string): string {
  return `${CONTRACT_DOC_PREFIX}/${contractId}/${uuid}.pdf`;
}

/** 上傳前擋門：只收 PDF、10 MB 以內。回 null 才能傳 */
export function contractDocError(f: { name: string; type: string; size: number }): string | null {
  const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  if (!isPdf) return `「${f.name}」不是 PDF。契約文件只收 PDF —— 照片請先用手機掃描 App 存成 PDF。`;
  if (f.size > CONTRACT_DOC_MAX) {
    return `「${f.name}」有 ${(f.size / 1024 / 1024).toFixed(1)} MB，超過 10 MB 上限。到 iLovePDF／PDF24 壓縮後再傳。`;
  }
  return null;
}

/** 新上傳的預設類型：還沒有原約就是原約，有了就是展延 */
export function defaultDocKind(existing: { doc_kind: string | null }[]): DocKind {
  return existing.some((d) => d.doc_kind === '原約') ? '展延' : '原約';
}

/** 排序：原約 → 展延 → 附約 → 其他，同類型照上傳時間 */
export function sortDocs<T extends { doc_kind: string | null; created_at: string }>(rows: T[]): T[] {
  const rank = (k: string | null) => { const i = DOC_KINDS.indexOf((k ?? '其他') as DocKind); return i < 0 ? 99 : i; };
  return [...rows].sort((a, b) => rank(a.doc_kind) - rank(b.doc_kind) || a.created_at.localeCompare(b.created_at));
}

/** 列表用：每張契約幾份 */
export function countByContract(rows: { contract_id: string | null }[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) if (r.contract_id) m[r.contract_id] = (m[r.contract_id] ?? 0) + 1;
  return m;
}

/** 摺疊區塊右邊那行字 */
export function docsSummary(n: number): string {
  return n > 0 ? `${n} 份` : '還沒上傳';
}

export function fmtSize(b: number | null | undefined): string {
  const n = Number(b) || 0;
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/* ══════ 客戶管理 → 契約 ══════ */

/** 跟 customers.name_key 同一個正規化：小寫、去掉所有空白 */
export function nameKey(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, '');
}

/**
 * 這位客戶的契約：租戶名（正規化後）一樣，而且同一個物業（客戶沒有物業就不限）。
 * ★ 新的排前面 —— 客戶頁最常看的是現在這一份。
 */
export function contractsOfCustomer<T extends { tenant_name: string | null; estate_id: string | null; start_date: string | null }>(
  c: { name: string; estate_id: string | null }, contracts: T[],
): T[] {
  const k = nameKey(c.name);
  if (!k) return [];
  return contracts
    .filter((x) => nameKey(x.tenant_name) === k && (!c.estate_id || x.estate_id === c.estate_id))
    .sort((a, b) => String(b.start_date ?? '').localeCompare(String(a.start_date ?? '')));
}
