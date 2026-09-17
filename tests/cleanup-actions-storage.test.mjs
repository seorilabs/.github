import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupActionsStorage, humanBytes } from '../scripts/cleanup-actions-storage.mjs';

const ENV = { GH_TOKEN: 'ghs_canary_token_value', GITHUB_API_URL: 'https://api.github.com' };

function response({ status = 200, body = '', headers = {} } = {}) {
  const bytes = Buffer.from(body, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async json() {
      return JSON.parse(bytes.toString('utf8'));
    },
    async text() {
      return bytes.toString('utf8');
    },
  };
}

function recorder(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET' });
    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) {
        return typeof handler === 'function' ? handler(url) : handler;
      }
    }
    throw new Error(`스텁에 없는 요청: ${url}`);
  };
  return { fetchImpl, calls };
}

test('humanBytes는 단위를 올려 표시한다', () => {
  assert.equal(humanBytes(0), '0.00 B');
  assert.equal(humanBytes(1024), '1.00 KiB');
  assert.equal(humanBytes(1536), '1.50 KiB');
  assert.equal(humanBytes(1024 ** 3), '1.00 GiB');
});

// gh api --paginate 대체가 Link 헤더를 실제로 따라가는지. 첫 페이지만 지우면 조용히 남는다.
test('artifacts 목록은 Link 헤더의 다음 페이지까지 모은다', async () => {
  const { fetchImpl, calls } = recorder([
    [
      'per_page=100&page=2',
      response({ body: JSON.stringify({ artifacts: [{ id: 3, name: 'c', size_in_bytes: 30 }] }) }),
    ],
    [
      '/actions/artifacts?per_page=100',
      response({
        body: JSON.stringify({
          artifacts: [
            { id: 1, name: 'a', size_in_bytes: 10 },
            { id: 2, name: 'b', size_in_bytes: 20 },
          ],
        }),
        headers: {
          link: '<https://api.github.com/repos/seorilabs/x/actions/artifacts?per_page=100&page=2>; rel="next"',
        },
      }),
    ],
  ]);

  const result = await cleanupActionsStorage({
    kind: 'artifacts',
    repository: 'seorilabs/x',
    dryRun: true,
    env: ENV,
    fetchImpl,
    log: () => {},
  });

  assert.equal(result.count, 3);
  assert.equal(result.bytes, 60);
  assert.equal(result.processed, 3);
  assert.equal(calls.filter(({ method }) => method === 'DELETE').length, 0);
});

test('dry_run이 아니면 항목마다 DELETE를 보낸다', async () => {
  const { fetchImpl, calls } = recorder([
    [
      '/actions/caches/',
      response({ status: 204 }),
    ],
    [
      '/actions/caches?per_page=100',
      response({
        body: JSON.stringify({
          actions_caches: [
            { id: 11, key: 'node-a', size_in_bytes: 100 },
            { id: 12, key: 'node-b', size_in_bytes: 200 },
          ],
        }),
      }),
    ],
  ]);

  const result = await cleanupActionsStorage({
    kind: 'caches',
    repository: 'seorilabs/x',
    dryRun: false,
    env: ENV,
    fetchImpl,
    log: () => {},
  });

  assert.equal(result.processed, 2);
  const deletes = calls.filter(({ method }) => method === 'DELETE').map(({ url }) => url);
  assert.deepEqual(deletes, [
    'https://api.github.com/repos/seorilabs/x/actions/caches/11',
    'https://api.github.com/repos/seorilabs/x/actions/caches/12',
  ]);
});

test('DELETE가 실패하면 조용히 넘어가지 않는다', async () => {
  const { fetchImpl } = recorder([
    ['/actions/artifacts/9', response({ status: 403, body: '{"message":"Forbidden"}' })],
    [
      '/actions/artifacts?per_page=100',
      response({ body: JSON.stringify({ artifacts: [{ id: 9, name: 'a', size_in_bytes: 1 }] }) }),
    ],
  ]);

  await assert.rejects(
    () =>
      cleanupActionsStorage({
        kind: 'artifacts',
        repository: 'seorilabs/x',
        dryRun: false,
        env: ENV,
        fetchImpl,
        log: () => {},
      }),
    /HTTP 403/u,
  );
});

test('목록이 비면 삭제 요청 없이 끝난다', async () => {
  const { fetchImpl, calls } = recorder([
    ['/actions/artifacts?per_page=100', response({ body: JSON.stringify({ artifacts: [] }) })],
  ]);
  const result = await cleanupActionsStorage({
    kind: 'artifacts',
    repository: 'seorilabs/x',
    dryRun: false,
    env: ENV,
    fetchImpl,
    log: () => {},
  });
  assert.deepEqual(
    { count: result.count, processed: result.processed },
    { count: 0, processed: 0 },
  );
  assert.equal(calls.length, 1);
});

test('알 수 없는 kind와 저장소 형식은 요청 전에 막는다', async () => {
  const never = () => {
    throw new Error('요청이 나가면 안 된다.');
  };
  await assert.rejects(
    () => cleanupActionsStorage({ kind: 'runs', repository: 'seorilabs/x', env: ENV, fetchImpl: never }),
    /artifacts 또는 caches만 쓴다/u,
  );
  await assert.rejects(
    () => cleanupActionsStorage({ kind: 'artifacts', repository: 'x', env: ENV, fetchImpl: never }),
    /owner\/name이 아니다/u,
  );
});
