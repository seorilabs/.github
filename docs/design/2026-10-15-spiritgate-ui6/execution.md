# 중앙 UI6 검증기 실행 기록

- 승인 범위 기록 커밋: `d6e0a1b`; 기준 main: `1e2710983bff98ef1062c7fd7d920bd2bec4eb0f`.
- 실행은 Node24.16.0/npm11.13.0의 중앙 Node 테스트다. 실제 게임 UI6·마켓 빌드·Android/iPhone·E2E 완료 근거가 아니다.
- TDD RED: 87개 중83통과/4실패. 기존4/5 경로는 통과했고 승인된6회 허용 및 새 예산 오류코드 검사가 기존 schema의6회 거절로 실패했다(`TESTFLIGHT_BOOTSTRAP_REQUIRED`). 문법/도구 실패가 아니다.
- 최소 구현 후 targeted GREEN:95/95 통과. 과거 UI5의 source/configuration bytes 및 원문 승인/proposal과 UI6 새 후보/설정·승인을 분리 결속한다. 원문을 새 후보로 고치는 경우와 hash를 다시 묶어도 내용이 불일치하는 경우를 거절한다.
- 전체 회귀 첫 실행:571개 중570통과/1차단. `rn-static-registry-auth`의 localhost fixture가 샌드박스 `listen EPERM 127.0.0.1`으로 실패했다. 동일 명령을 loopback 사용이 허용된 환경에서1회 실행해571/571 통과했다. 코드나 테스트 기대값을 바꾸지 않았다.
- `npm run pack:check`, `git diff --check`, 중앙 테스트 계획 schema 검증 통과. UI5 승인 파일과 UI6 승인 당시 제안 bytes의 원문 hash를 재확인했다. 보조 Python 확인은 PyYAML 미설치로 중단됐고 기존 Node yaml 의존성으로 같은 읽기 검사를 완료했다.
- 기존4/5 경로의 source/config 검사, 정상v2/L3 계약/검증기, 프로덕션 서명 검사는 변경하지 않았다. grantRegistry는 계속 빈 배열이며 실제 PASS·grant·태그·번호·빌드·업로드를 만들지 않았다.
- 예산 기계 검사는 기존과 같이 각4/5/6회 합산210분이다. 본180분·재확인 단1회30분이라는 승인 필드/hash와 실제 보고서의 분리 구간은 중앙 등록 검토에서 함께 확인한다. 이 문서로 실제 실행 시간을 대신하지 않는다.
- PR·Claude 읽기 전용 전송은 root와 조율 후 수행한다. 총 리뷰 요청2회 상한을 유지한다.

## 원본 테스트 출력

원문은 소유 호스트의 임시 실행 파일로 보존한다. 내용이나 실제 제품 실행 로그를 이 중앙 저장소에 복사하지 않는다.

```json
[
  {
    "file": "sgd-central-ui6-red.log",
    "sha256": "78155e8441e3033077884e72a57da1e2da2383371ca98429b57c234c661b3521"
  },
  {
    "file": "sgd-central-ui6-green-targeted.log",
    "sha256": "f49bc2aaef7d6e3f4e85094c89e522a9add155a23a22ffdec0b54342c0bbad78"
  },
  {
    "file": "sgd-central-ui6-full-test.log",
    "sha256": "37c93764c0ff6cbfd36a35140c78c1a18d6d4528e8609b98c22b460cd0ca8b9d"
  },
  {
    "file": "sgd-central-ui6-full-test-unsandboxed.log",
    "sha256": "87e6f9d9ff950b8ec778892ef74281c6472b67a5cad5d40d3fe84cde6bac975b"
  }
]
```
