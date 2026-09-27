import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

test('Play 오류는 단계 코드·허용된 원인만 출력하고 공급자 비밀값을 숨긴다', () => {
  const probe = `
import json, sys, types
sys.path.insert(0, sys.argv[1])
from google_play_client import PublicFailure, execute, safe_diagnostic
secret = 'secret-token-must-never-escape'
class HttpFailure(Exception):
    resp = types.SimpleNamespace(status=403)
    content = json.dumps({'error': {'message': secret, 'errors': [{'reason': 'insufficientPermissions'}, {'reason': secret}]}}).encode()
error = HttpFailure(secret)
assert safe_diagnostic(error) == 'HTTP_403,insufficientPermissions'
RefreshError = type('RefreshError', (Exception,), {'__module__': 'google.auth.exceptions'})
refresh = RefreshError('Permission iam.serviceAccounts.getAccessToken denied: ' + secret)
assert safe_diagnostic(refresh) == 'IAM_GET_ACCESS_TOKEN_DENIED,AUTH_REFRESH_FAILED'
assert safe_diagnostic(RuntimeError(secret)) == ''
class Request:
    def execute(self, num_retries):
        assert num_retries == 2
        raise error
try:
    execute(Request(), 2, 'GOOGLE_PLAY_EDIT_CREATE_FAILED')
except PublicFailure as failure:
    assert failure.code == 'GOOGLE_PLAY_EDIT_CREATE_FAILED'
    assert str(failure) == 'GOOGLE_PLAY_EDIT_CREATE_FAILED [HTTP_403,insufficientPermissions]'
    assert secret not in str(failure)
else:
    raise AssertionError('request should fail')
assert str(PublicFailure('EXISTING_CODE')) == 'EXISTING_CODE'
print('safe diagnostics PASS')
`;
  const result = spawnSync('python3', ['-c', probe, resolve('scripts/release')], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /safe diagnostics PASS/);
});
