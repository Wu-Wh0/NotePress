'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DICTIONARIES, normalizeLocale, translate, issueMessage, resultMessage } = require('../src/i18n');

test('locale dictionary has matching keys and non-empty strings for both supported languages', () => {
  assert.deepEqual(Object.keys(DICTIONARIES.en).sort(), Object.keys(DICTIONARIES['zh-CN']).sort());
  for (const dictionary of Object.values(DICTIONARIES)) {
    for (const value of Object.values(dictionary)) assert.equal(typeof value === 'string' && value.length > 0, true);
  }
});

test('locale normalization defaults to Simplified Chinese and rejects unsupported values', () => {
  assert.equal(normalizeLocale(undefined), 'zh-CN');
  assert.equal(normalizeLocale('en'), 'en');
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
  for (const invalid of ['EN', 'fr', '', null, {}, 'en-US']) assert.equal(normalizeLocale(invalid), 'zh-CN');
  assert.equal(translate('invalid', 'settings.title'), translate('zh-CN', 'settings.title'));
});

test('diagnostics resolve stable issue and result codes without exposing codes or Chinese source strings', () => {
  assert.match(issueMessage('en', 'missing_image'), /image/i);
  assert.match(issueMessage('zh-CN', 'missing_image'), /图片/);
  assert.match(resultMessage('en', { status: 'blocked', reason: 'journal-unavailable' }), /journal|save|storage/i);
  assert.match(resultMessage('zh-CN', { status: 'blocked', reason: 'journal-unavailable' }), /记录|保存/);
  assert.doesNotMatch(resultMessage('en', { status: 'blocked', reason: 'unknown-internal-code' }), /unknown-internal-code/);
});
