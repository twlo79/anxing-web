import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabFromSearch, searchWithTab } from './url-tab.ts';

test('tabFromSearch：認得的才回', () => {
  assert.equal(tabFromSearch('?tab=stats', 'tab', ['calendar', 'stats']), 'stats');
  assert.equal(tabFromSearch('?tab=nope', 'tab', ['calendar', 'stats']), null);
  assert.equal(tabFromSearch('', 'tab', ['calendar']), null);
});
test('searchWithTab：其他參數留著', () => {
  assert.equal(searchWithTab('?ym=202609&tab=calendar', 'tab', 'stats'), '?ym=202609&tab=stats');
  assert.equal(searchWithTab('', 'tab', 'stats'), '?tab=stats');
});
