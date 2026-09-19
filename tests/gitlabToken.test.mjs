import test from 'node:test';
import assert from 'node:assert/strict';
import { GITLAB_CAPABILITIES, tokenCapability, tokenExpiry } from '../src/gitlabToken.ts';

const now = Date.parse('2026-09-20T12:00:00Z');
const token = { name: 'fixture', scopes: ['api'], expires_at: '2026-10-20', expiry_known: true, active: true, revoked: false, granular: false };
const permissions = info => Object.fromEntries(GITLAB_CAPABILITIES.map(capability => [capability.title, tokenCapability(info, capability, now)]));

test('expiry is midnight UTC, not end of day or local midnight', () => {
  assert.equal(tokenExpiry({ ...token, expires_at: '2026-09-21' }, now).label, '剩余 12 小时');
  assert.equal(tokenExpiry({ ...token, expires_at: '2026-09-21' }, Date.parse('2026-09-21T00:00:00Z')).expired, true);
  assert.equal(tokenExpiry({ ...token, expires_at: '2026-09-21' }, Date.parse('2026-09-20T23:59:00Z')).label, '不足 1 小时');
  assert.equal(tokenExpiry(token, now).tone, 'green');
});
test('missing or malformed expiry is unknown; explicit null is no expiry', () => {
  assert.equal(tokenExpiry(null, now).label, '无法确认');
  assert.equal(tokenExpiry({ ...token, expiry_known: false, expires_at: null }, now).label, '无法确认');
  for (const value of ['invalid', '2026-02-30', '2026-9-2']) assert.equal(tokenExpiry({ ...token, expires_at: value }, now).label, '无法确认');
  assert.equal(tokenExpiry({ ...token, expires_at: null }, now).label, '未设置到期时间');
});
test('api includes Git-over-HTTP read/write; read_api does not', () => {
  assert.ok(Object.values(permissions(token)).every(value => value === 'granted'));
  const read = permissions({ ...token, scopes: ['read_api'] });
  assert.equal(read['查看项目'], 'granted');
  assert.equal(read['创建合并请求'], 'denied');
  assert.equal(read['拉取代码'], 'denied');
  assert.equal(read['推送代码'], 'denied');
});
test('repository-only tokens do not imply API permissions', () => {
  const write = permissions({ ...token, scopes: ['write_repository'] });
  assert.equal(write['拉取代码'], 'granted');
  assert.equal(write['推送代码'], 'granted');
  assert.equal(write['查看项目'], 'denied');
  assert.equal(write['创建合并请求'], 'denied');
  assert.equal(permissions({ ...token, scopes: ['read_repository'] })['推送代码'], 'denied');
});
test('unknown and fine-grained scopes are never reported as missing authorization', () => {
  for (const info of [null, { ...token, scopes: null }, { ...token, granular: true }]) {
    assert.ok(Object.values(permissions(info)).every(value => value === 'unknown'));
  }
  assert.ok(Object.values(permissions({ ...token, scopes: [] })).every(value => value === 'denied'));
});
test('revoked, inactive, or expired tokens never display usable capabilities', () => {
  for (const info of [{ ...token, revoked: true }, { ...token, active: false }, { ...token, expires_at: '2026-09-20' }]) {
    assert.ok(Object.values(permissions(info)).every(value => value === 'inactive'));
  }
});
