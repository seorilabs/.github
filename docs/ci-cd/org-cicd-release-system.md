# 조직 CI/CD·릴리스 실행

정본은 [release-policy.yaml](../../contracts/release-policy.yaml), [버전 계약](../../contracts/release-version-authority.yaml), [개발 워크플로우](../agent-governance/development-workflow.md)와 실제 [재사용 workflow](../../.github/workflows/README.md)다. 이 문서는 진입 안내다. 과거 저장소별 점검 목록·Secret 복사 목록·이관 예정 상태·중복 caller 예제는 현재 운영 근거로 사용하지 않는다.

## 진행 조건

- main·PR은 정적 검사다. 자동 버전 태그·마켓 업로드·프로덕션 배포를 실행하지 않는다. 웹 Pages도 명시 dispatch 또는 tag에서만 빌드·배포한다.
- 실제 구현은 사람의 승인 설계·인수조건과 같은 커밋의 테스트 계획(`test-plan.json`: 등급 L1~L3·실행 환경·출시 마켓·끝 지점)부터 시작한다. 계획한 실행을 기록하고 빌드·배포·출시 직전에 근거를 검증한다. 같은 후보 SHA의 통과한 실행은 168시간 동안 이후 단계에도 쓴다.
- 마켓 작업은 승인된 exact source SHA의 명시 SemVer tag에서 수행한다. 태그 버전·원장 할당값을 산출물에서 다시 확인한다.
- 일반 private CI는 현재 `global-versions.yaml`의 general runner, public은 GitHub-hosted runner로 분기한다. Android release는 x64 Linux다. Apple은 public의 hosted macOS, private의 Xcode Cloud다. private Apple 작업을 macOS Actions로 우회하지 않는다.
- thin caller는 중앙 workflow `@main`을 참조한다. 작업 중에는 읽은 중앙 커밋과 스키마를 고정한다. 앱 저장소에 정책 전문을 복사하지 않는다.
- `secrets: inherit`는 금지한다. 필요한 이름만 명시적으로 전달하고 값은 등록된 로컬 catalog·실행 Secret에서 해석한다.
- 산출물 retention은 중앙 계약을 따르고 중요한 QA 증거는 만료 전에 제품 정책에 맞게 보존한다.

## 빌드·배포

1. 승인 범위·레포·태그·마켓·종료 목표와 실제 후보를 고정한다.
2. 마켓별 문구·모든 활성 언어를 검수하고 태그 Release에 필요한 출시노트를 연결한다.
3. 계획한 개발 환경 실행을 마치고 해당 SHA·마켓의 `before-build` 근거를 준비한다.
4. 중앙 workflow의 검증기가 근거와 승인 커밋의 계획을 다시 읽어 승인·하한·후보·시간·실행 범위를 확인한 뒤 빌드·테스트 채널 업로드를 한다. 없거나 차단됐으면 중단한다.
5. 계획에 실기기가 있거나 바뀐 파일로 하한이 올라가면 테스트 채널 빌드(또는 같은 SHA 빌드)로 실기기 실행을 하고 `before-release` 근거를 올린다. Play production 승격 workflow와 App Store·앱인토스 심사 제출 직전 로컬 실행이 `before-release`로 실기기 실행·출시 마켓·끝 지점을 확인한다. 웹·서비스는 `before-deploy`가 출시 검사다. 후보 SHA가 바뀌거나 168시간이 지나면 다시 실행한다. L3의 영향 없는 기반 기능은 30일 안의 실제 실행 근거를 이어받는다.
6. 산출물·업로드·처리·실기기 QA·심사·승인·배포·공개·live 결과를 각각 재조회한다. build green이나 업로드 응답을 공개 완료로 보고하지 않는다. 계획의 끝 지점(기본 공개)까지 정지 조건이 없으면 사람에게 다시 묻지 않고 진행한다.

실제 릴리스 실행은 `seorilabs-release-run`, 마켓별 메타데이터와 인증은 해당 전문 스킬, 공개 완료 판정은 `multimarket-launch-completion`이 담당한다. 정책 변경만으로 모든 제품의 실제 검수나 외부 Xcode Cloud 훅 설치가 완료됐다고 표시하지 않는다.

## 검증

```bash
npm ci
npm test
npm run pack:check
actionlint -config-file .github/actionlint.yaml .github/workflows/*.yml
git diff --check
```
