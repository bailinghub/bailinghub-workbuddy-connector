import assert from 'node:assert/strict';
import test from 'node:test';

import { publicCliFailure } from '../dist/cli.js';

test('CLI failures do not expose arbitrary local or remote error details', () => {
  const privatePath = ['', 'Users', 'private-user', 'credentials.json'].join('/');
  const sanitized = publicCliFailure(new Error(`${privatePath} EACCES token=private-value`));
  assert.equal(sanitized.includes(privatePath), false);
  assert.equal(sanitized.includes('private-value'), false);
  assert.match(sanitized, /failed safely/);
});

test('CLI preserves only explicitly safe operator guidance', () => {
  assert.equal(
    publicCliFailure(new Error('No BailingHub connection is configured.')),
    'No BailingHub connection is configured.',
  );
  assert.equal(
    publicCliFailure(new Error('Usage: bailinghub-workbuddy connections use <connection-name>')),
    'Usage: bailinghub-workbuddy connections use <connection-name>',
  );
});
