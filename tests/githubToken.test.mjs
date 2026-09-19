import test from 'node:test';
import assert from 'node:assert/strict';
import { GITHUB_CAPABILITIES, githubCapability, githubTokenExpiry, validGithubUrl } from '../src/githubToken.ts';

const now = Date.parse('2026-09-20T12:00:00Z');
const token = { login: 'fixture', name: null, token_kind: 'classic', scopes: ['repo'], expires_at: '2026-10-20T12:00:00+00:00' };
const permissions = info => Object.fromEntries(GITHUB_CAPABILITIES.map(capability => [capability.id, githubCapability(info, capability.id, now)]));

test('repo grants repository operations but never invents workflow, org, or package scopes', () => {
  const actual = permissions(token);
  for (const id of ['profile', 'private_read', 'push', 'pull_request', 'create_repo']) assert.equal(actual[id], 'granted');
  for (const id of ['workflow', 'org', 'packages_read', 'packages_write']) assert.equal(actual[id], 'denied');
  assert.equal(permissions({ ...token, scopes: ['repo', 'workflow'] }).workflow, 'granted');
  assert.equal(permissions({ ...token, scopes: ['workflow'] }).workflow, 'denied');
});
test('public_repo stays visibly limited to public repositories', () => {
  const actual = permissions({ ...token, scopes: ['public_repo', 'workflow'] });
  for (const id of ['push', 'pull_request', 'create_repo', 'workflow']) assert.equal(actual[id], 'public');
  assert.equal(actual.private_read, 'denied');
});
test('fine-grained or missing scopes cannot be interpreted as denied or full access', () => {
  for (const info of [{ ...token, token_kind: 'fine_grained' }, { ...token, scopes: null }, { ...token, token_kind: 'other' }]) {
    const actual = permissions(info);
    assert.equal(actual.profile, 'granted');
    for (const id of Object.keys(actual).filter(id => id !== 'profile')) assert.equal(actual[id], 'unknown');
  }
  assert.ok(Object.values(permissions(null)).every(status => status === 'unknown'));
  assert.equal(permissions({ ...token, scopes: [] }).private_read, 'denied');
});
test('parent organization and package scopes include their read capabilities', () => {
  assert.equal(permissions({ ...token, scopes: ['admin:org'] }).org, 'granted');
  assert.equal(permissions({ ...token, scopes: ['write:org'] }).org, 'granted');
  assert.equal(permissions({ ...token, scopes: ['write:packages'] }).packages_read, 'granted');
  assert.equal(permissions({ ...token, scopes: ['read:packages'] }).packages_write, 'denied');
});
test('expiry uses the full timestamp and zone; absent headers are unknown, never unlimited', () => {
  const info = { ...token, expires_at: '2026-09-20T23:00:00-05:00' };
  assert.equal(githubTokenExpiry(info, now).label, '剩余 16 小时');
  assert.equal(githubTokenExpiry(info, now).date, '2026-09-21 04:00 UTC');
  assert.equal(githubTokenExpiry(info, Date.parse('2026-09-21T04:00:00Z')).expired, true);
  for (const expires_at of [null, '', 'invalid']) assert.equal(githubTokenExpiry({ ...token, expires_at }, now).label, '有效期未知');
  assert.ok(Object.values(permissions({ ...token, expires_at: '2026-09-20T12:00:00Z' })).every(value => value === 'inactive'));
});
test('public instance may be blank, enterprise URL must be a valid root', () => {
  for (const url of ['', 'https://github.com/', 'https://api.github.com', 'https://work.example/github', 'http://work.example:8080']) assert.equal(validGithubUrl(url), true);
  for (const url of ['work.example', 'file:///tmp/test', 'https://user:secret@work.example', 'https://github.com/repo', 'https://work.example?secret=1']) assert.equal(validGithubUrl(url), false);
});
