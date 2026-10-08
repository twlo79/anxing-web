import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DOC_KINDS, canSeeContractDocs, docPath, contractDocError, defaultDocKind, sortDocs,
  countByContract, docsSummary, fmtSize, nameKey, contractsOfCustomer,
} from './contract-docs.ts';

test('★ DOC_KINDS 跟 migration_324 的 check 同步', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/migration_324_contract_docs.sql', import.meta.url), 'utf8');
  for (const k of DOC_KINDS) assert.ok(sql.includes(`'${k}'`), `migration_324 沒有 ${k}`);
});

test('權限：主管、會計、總經理；管家不行', () => {
  assert.equal(canSeeContractDocs('accountant'), true);
  assert.equal(canSeeContractDocs('manager'), true);
  assert.equal(canSeeContractDocs('super_admin'), true);
  assert.equal(canSeeContractDocs('housekeeper'), false);
  assert.equal(canSeeContractDocs(null), false);
});

test('路徑前綴 ct/', () => {
  assert.equal(docPath('c1', 'u1'), 'ct/c1/u1.pdf');
});

test('只收 PDF、10 MB', () => {
  assert.equal(contractDocError({ name: 'a.pdf', type: 'application/pdf', size: 1000 }), null);
  assert.equal(contractDocError({ name: 'a.PDF', type: '', size: 1000 }), null);
  assert.match(contractDocError({ name: 'a.jpg', type: 'image/jpeg', size: 1000 })!, /不是 PDF/);
  assert.match(contractDocError({ name: 'a.pdf', type: 'application/pdf', size: 11 * 1024 * 1024 })!, /10 MB/);
});

test('預設類型：沒原約→原約，有了→展延', () => {
  assert.equal(defaultDocKind([]), '原約');
  assert.equal(defaultDocKind([{ doc_kind: '原約' }]), '展延');
});

test('排序：原約在前，同類照時間', () => {
  const r = sortDocs([
    { doc_kind: '展延', created_at: '2026-10-01' }, { doc_kind: null, created_at: '2026-01-01' },
    { doc_kind: '原約', created_at: '2026-08-11' }, { doc_kind: '展延', created_at: '2026-09-01' },
  ]);
  assert.deepEqual(r.map((x) => `${x.doc_kind}${x.created_at.slice(5)}`), ['原約08-11', '展延09-01', '展延10-01', 'null01-01']);
});

test('countByContract / docsSummary / fmtSize', () => {
  assert.deepEqual(countByContract([{ contract_id: 'a' }, { contract_id: 'a' }, { contract_id: null }, { contract_id: 'b' }]), { a: 2, b: 1 });
  assert.equal(docsSummary(0), '還沒上傳');
  assert.equal(docsSummary(2), '2 份');
  assert.equal(fmtSize(1.2 * 1024 * 1024), '1.2 MB');
  assert.equal(fmtSize(340 * 1024), '340 KB');
});

test('客戶 → 契約：名字正規化、同物業、新的在前', () => {
  assert.equal(nameKey(' 譚 展泉 '), '譚展泉');
  const cs = [
    { id: '1', tenant_name: '譚展泉', estate_id: 'E', start_date: '2024-03-01' },
    { id: '2', tenant_name: '譚 展泉', estate_id: 'E', start_date: '2026-08-11' },
    { id: '3', tenant_name: '譚展泉', estate_id: 'F', start_date: '2025-01-01' },
    { id: '4', tenant_name: '別人', estate_id: 'E', start_date: '2026-01-01' },
  ];
  assert.deepEqual(contractsOfCustomer({ name: '譚展泉', estate_id: 'E' }, cs).map((x) => x.id), ['2', '1']);
  assert.deepEqual(contractsOfCustomer({ name: '譚展泉', estate_id: null }, cs).map((x) => x.id), ['2', '3', '1']);
  assert.deepEqual(contractsOfCustomer({ name: '', estate_id: null }, cs), []);
});
