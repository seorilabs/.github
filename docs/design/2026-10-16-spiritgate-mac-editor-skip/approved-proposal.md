# 막힌 Mac Editor만 생략하고 실기기 검수로 전환

사용자가 실제로 선택한 범위는 “막힌 Mac Editor 검수만 생략”이다. UI10의 첫 입력 관찰 실패·중단·소유 프로세스 종료·미완료·0PASS 원문과 UI1~9의 기존 승인·실패 이력은 그대로 보존한다. UI10을 다시 시작하거나 입력 가드를 고치지 않는다. 생략을 통과로 표시하지 않는다.

정상 v2는 Android/iOS만 계획한 경우 before-build/before-deploy에서 아직 실기기에 설치할 빌드가 없다는 순서에 맞게 UI3 필수를 before-release로 미룬다. dev가 포함된 계획의 기존 조기 UI3 필수는 유지한다. 기록한 회차는 단계와 무관하게 기존 순서·독립성·실패 해결 검사를 통과해야 한다. 승인 계획·인수조건·TDD·등급·하한·전체28기능·168영역을 줄이지 않는다. 공개1.1.1에는 Android+iPhone의 실제 L3·전체 E2E·독립 UI3가 필요하다.

첫 내부1.1.0은 원래 bootstrap 경로와 정확 서명 산출물 gate를 유지한다. 별도 검토된 Mac skip 승인·원문6역할·현재 최종 후보를 결속한 경우에만 Editor UI/E2E의 skipped_incomplete/skipped 상태를 허용한다. 원래 d031 UI10의 승인·source·QA 설정·실패 시각을 새 후보의 PASS로 소급하지 않는다. 현재 후보는 승인 계획 문서 통합 후의 SHA이며 게임 구현은 변하지 않았다. 공통 configurationFingerprint는 기존 첫 내부 개발 QA 구성 참조로 쓰며 실제 native 마켓 설정이라는 뜻이 아니다. Android 마켓 설정 지문·실제 native 산출물/프로필 검증은 별도다.

실제 같은 최종 SHA Android 실기기 기반4 전체 통과가 있어야 하며 completedAt은 그 실제 Android 완료시각을 쓴다. iPhone 검수는 첫 내부 설치 뒤 수행할 순서만 유지하며 면제하지 않는다. 별도 전체 E2E와 공개 L3·native 검수도 면제하지 않는다. nativeQaWaived=false, productE2eStatus=blocked, publicReleaseAllowed=false를 유지한다.

원래 만료 2026-10-20T23:16:52.580641Z·최대168시간·v1 종료 2026-10-22T00:00:00Z를 연장하지 않는다. 한 후보·한 Cloud 빌드·한 업로드, 기존 production 프로필·인증서·entitlements·같은 provider/build·정확 signed artifact 자동 검증을 유지한다. 잘못된 실제 서명 산출물이면 중단하며 새 시도로 우회하지 않는다. 새 키·IAM·프로필·Cloud 시도·시장 공개 권한은 만들지 않는다.

원본은 비공개 보존 경로에 유지하고 공개 문서는 승인 답변·시각·원문 hash·동일 범위만 남긴다. 공개 receipt는 원본 사용자 기록을 대체하지 않는다. 자격증명·PixelLab 원본·개인정보·질문·실행 로그·관찰 원문은 외부 코드 리뷰에 포함하지 않는다. 이번 중앙 구현은 Ready PR과 필수 검사까지 진행하며 Claude 전송·병합은 별도 확정 전 보류한다. 자동 Copilot을 명시 요청하지 않으며 실제 자동 요청을 포함해 PR당 총2회 상한을 유지한다. 실제 Android/최종 근거가 없으므로 registry[]·grant·핀·태그·번호·Cloud 빌드는 모두0이다.
