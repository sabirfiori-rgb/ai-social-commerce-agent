/**
 * Auth layer: token validation, header extraction, public-path allowlist.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, extractToken } from '../src/interface/http/auth.ts';

function req(headers: Record<string, string>): { headers: Record<string, string> } {
  return { headers };
}

describe('auth', () => {
  test('is open (disabled) when no tokens are configured', () => {
    const a = createAuth({ enabled: false, tokens: [] });
    assert.equal(a.enabled, false);
    assert.equal(a.check(req({}) as never), true);
    assert.equal(a.validate('anything'), true);
  });

  test('enabled validates configured tokens in constant time', () => {
    const a = createAuth({ enabled: true, tokens: ['abc', 'def'] });
    assert.equal(a.enabled, true);
    assert.equal(a.validate('abc'), true);
    assert.equal(a.validate('def'), true);
    assert.equal(a.validate('xyz'), false);
    assert.equal(a.validate(''), false);
    assert.equal(a.validate(null), false);
  });

  test('extractToken reads Bearer and X-API-Key', () => {
    assert.equal(extractToken(req({ authorization: 'Bearer tok123' }) as never), 'tok123');
    assert.equal(extractToken(req({ authorization: 'bearer tok123' }) as never), 'tok123');
    assert.equal(extractToken(req({ 'x-api-key': 'k9' }) as never), 'k9');
    assert.equal(extractToken(req({}) as never), null);
  });

  test('check enforces a valid token when enabled', () => {
    const a = createAuth({ enabled: true, tokens: ['s3cret'] });
    assert.equal(a.check(req({ authorization: 'Bearer s3cret' }) as never), true);
    assert.equal(a.check(req({ authorization: 'Bearer nope' }) as never), false);
    assert.equal(a.check(req({}) as never), false);
  });

  test('health + login paths are public; app routes are not', () => {
    const a = createAuth({ enabled: true, tokens: ['x'] });
    assert.equal(a.isPublic('/api/health'), true);
    assert.equal(a.isPublic('/api/health/ready'), true);
    assert.equal(a.isPublic('/api/auth/login'), true);
    assert.equal(a.isPublic('/api/dashboard'), false);
    assert.equal(a.isPublic('/api/admin/backups'), false);
  });
});
