import assert from 'node:assert/strict';
import test from 'node:test';

import { collectConnectionConfiguration, parseConnectionForm } from '../dist/config-page.js';

const csrf = 'csrf-value';
const form = (values = {}) => new URLSearchParams({
  csrf,
  hub_url: 'https://hub.example.com',
  client_app_id: 'merchant-agent',
  workspace: 'order-assistant',
  connection_name: 'shop-a',
  ...values,
}).toString();

test('configuration form accepts only public connection metadata', () => {
  assert.deepEqual(parseConnectionForm(form(), csrf, 'darwin'), {
    hubUrl: 'https://hub.example.com',
    clientAppId: 'merchant-agent',
    workspace: 'order-assistant',
    connectionName: 'shop-a',
    linuxFileCredentialStoreConfirmed: false,
  });
  assert.throws(
    () => parseConnectionForm(form({ hub_url: 'http://hub.example.com' }), csrf, 'darwin'),
    /HTTPS/,
  );
  assert.throws(
    () => parseConnectionForm(form({ hub_url: ['https://user', 'secret@hub.example.com'].join(':') }), csrf, 'darwin'),
    /不能包含凭据/,
  );
});

test('Linux file credential storage requires an explicit human confirmation', () => {
  assert.throws(() => parseConnectionForm(form(), csrf, 'linux'), /mode-0600/);
  const accepted = parseConnectionForm(form({ linux_file_store: 'yes' }), csrf, 'linux');
  assert.equal(accepted.linuxFileCredentialStoreConfirmed, true);
});

test('configuration form rejects expired CSRF state', () => {
  assert.throws(() => parseConnectionForm(form(), 'different', 'darwin'), /已失效/);
});

test('oversized configuration form returns 413 without breaking a valid retry', async () => {
  let opened;
  const browserOpened = new Promise((resolve) => { opened = resolve; });
  const pending = collectConnectionConfiguration({
    platform: 'darwin',
    timeoutMs: 5_000,
    openBrowser: async (url) => { opened(url); },
  });
  const url = await browserOpened;
  const page = await fetch(url);
  const html = await page.text();
  const csrfFromPage = html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(csrfFromPage);

  const oversized = await fetch(new URL('/configure', url), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf: csrfFromPage,
      hub_url: 'https://hub.example.com',
      client_app_id: 'merchant-agent',
      workspace: 'order-assistant',
      connection_name: 'x'.repeat(17_000),
    }),
  });
  assert.equal(oversized.status, 413);
  assert.match(await oversized.text(), /超过大小限制/);

  const retry = await fetch(new URL('/configure', url), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf: csrfFromPage,
      hub_url: 'https://hub.example.com',
      client_app_id: 'merchant-agent',
      workspace: 'order-assistant',
      connection_name: 'shop-a',
    }),
  });
  assert.equal(retry.status, 200);
  assert.equal((await pending).connectionName, 'shop-a');
});
