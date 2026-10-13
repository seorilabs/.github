# Reascend 1.1.0 운영 검증 위험 기록

출시 판단은 human_exception이며 실제 전체 제품 E2E는 blocked다. 원래 fixture PASS와 partial/unknown 판정을 보존한다. 실기기 결제 검증은 사람 승인으로 생략했다. Apple V2 설정 GET 일치는 기존 TEST HTTP404/token 없음과 실제 알림·환불 원장 미확인을 통과로 바꾸지 않는다. 서명·상품·판매자·정책·심사·공개·실서비스 조회는 별도 확인한다.

- native authentication
- remote account deletion
- save/error/restart integration and incomplete whole26-feature E2E
- previous Apple sandbox TEST HTTP404/no token and notification receiver/refund ledger unknown
- physical-device IAP purchase/recovery/refund tests waived
