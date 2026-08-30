# RPI4 격리와 RPI5 workload capacity 정책

기계 판독 정본은
[`fleet-rpi-capacity-policy.yaml`](../../contracts/fleet-rpi-capacity-policy.yaml)이다.
`SEORILABS_ARC_WORKSPACE/github-actions-runners`는 Git 저장소가 아닌 cluster 실행
복제본이며, 정본과의 일치는
[`verify-rpi-capacity-policy.mjs`](../../scripts/fleet/verify-rpi-capacity-policy.mjs)가
fail-closed로 확인한다.

## 결론과 적용 경계

- `rpi4001`은 기존 Pod를 이동하지 않은 채 cordon 상태를 유지한다. 새 active
  non-DaemonSet workload가 cordon 이후 이 노드에 생기면 검증 실패다. 종료된 진단
  readback Pod는 현재 capacity를 소비하지 않으므로 placement 실패로 세지 않되 감사 근거로
  보존한다.
- Backoffice automation scheduler, ARC controller/listener/general/DIND runner와 향후
  Auth Broker 세 workload는 exact `rpi5` selector를 사용한다.
- ARC 스케일셋은 arm64 general(`1/3`)·DIND(`0/1`)와 x64 general(`1/6`)·
  x64 android(`0/1`) 네 개다. 선언값, AutoscalingRunnerSet spec 또는
  current/pending/running 수가 상한을 벗어나면 검증 실패다. x64 두 스케일셋은
  러너를 `seori-m6-01`에 두고 리스너만 RPI5에 둔다.
- 이 변경은 cluster에 apply하지 않고, Pod를 이동하거나 `uncordon`·`taint`를 실행하지
  않는다. Auth Broker가 아직 배치되지 않은 상태는 `not_deployed`로 기록하되 renderer가
  RPI5 이외의 manifest를 생성하지 못하게 한다.

## 원인과 관찰 근거

2026-08-28 09:01:39 KST의 cordon 직후 `rpi4001`은 `Ready=True`,
`MemoryPressure=False`였다. `kubectl top node`는 5,440 MiB, 96%였지만 host
`/proc/meminfo`의 `MemAvailable`은 5,412,628 KiB, `Buffers`는 1,699,532 KiB,
`Cached`는 3,236,920 KiB였다. 상위 RSS는 `kubelite` 약 1.09 GiB와
`k8s-dqlite` 약 311 MiB였다. 따라서 node working set 비율만으로 제품 Pod 메모리 고갈을
판정할 수 없고, control-plane 프로세스와 회수 가능한 cache를 함께 확인해야 한다.

Happy Farm pilot에서 발생한 별도 ARC OOM은 runner의 4 GiB limit에서 병렬 Jest worker가
원인이었다. PR #491 HEAD `5aa7536d7172f83faceccd75dc68218306ab54a3`가
`maxWorkers=1`, `workerIdleMemoryLimit=512MB`를 고정한 뒤 run `33169317143`, job
`98843053333`은 성공했고 관측 peak는 2,308 MiB였다. 이 결과는 RPI4 node 포화가 아니라
workload별 동시성 제한으로 해결해야 할 OOM을 분리한다.

2026-08-29 05:27 KST readback은 다음 상태였다.

- `rpi4001`: `Ready=True`, `unschedulable=true`, `MemoryPressure=False`, node working
  set 약 4,565 MiB, Running Pod working set 합계 약 406 MiB
- `rpi5`: `Ready=True`, schedulable, `MemoryPressure=False`, node working set 약
  3,235 MiB
- scheduler·ARC·Auth Broker의 active RPI4 placement 0건, current Pod `OOMKilled`
  last state 0건, 보존 event의 OOM/eviction 0건. 별도 권한·backup 진단용으로 직접 실행된
  terminal readback Pod는 일반 workload와 분리한다.
- ARC live: general `1/3`, DIND `0/1`; controller, listener와 runner는 RPI5

2026-08-30에 `seori-m6-01`(amd64, `workload=ci:NoSchedule` taint, allocatable
11.5 CPU / 4.97Gi) 노드와 `seorilabs-x64`(general, `1/6`)·`seorilabs-x64-android`
(android, `0/1`) 스케일셋이 추가됐다([이슈 #78](https://github.com/seorilabs/.github/issues/78)).
두 스케일셋의 러너는 `seori-m6-01` + `workload=ci` toleration으로 배치되고, 리스너는
기존 세 workload와 동일하게 RPI5에 남는다(RPI4001 refresh 시 리스너가 죽는 문제 회피,
2026-08-22). `rpi4001` 격리와 RPI5 capacity 조건은 그대로다.

이 추가로 `cluster.nodes.x64`, x64 두 스케일셋, 스케일셋별 `listenerNodeSelector`·
`tolerations`가 필수 필드로 들어가 기존 계약 문서를 깨는 변경이므로
[AGENTS.md](../../AGENTS.md)의 major 분리 원칙에 따라 `schemaVersion`을 `1`에서
`2`로 올렸다. 스키마의 `schemaVersion` const, `title`, `$id`도 v2로 함께 갱신했다.

단, 위 시각은 cordon 뒤 약 20시간 25분이므로 24시간 관찰 완료 증거가 아니다. 최초로
24시간을 채우는 시각은 **2026-08-29 09:01:39 KST**다. verifier는 Node의
`node.kubernetes.io/unschedulable` taint `timeAdded`에서 직접 시간을 계산하며 24시간 전에
`RPI_CAPACITY_OBSERVATION_WINDOW_INCOMPLETE`로 실패한다.

## 검증

먼저 Git 미관리 실행 복제본만 비교한다.

```sh
SEORILABS_ARC_WORKSPACE=/absolute/path/to/kubectl \
  node scripts/fleet/verify-rpi-capacity-policy.mjs files
```

24시간 이후 live readback은 조회 명령만 실행한다.

```sh
SEORILABS_ARC_WORKSPACE=/absolute/path/to/kubectl \
  node scripts/fleet/verify-rpi-capacity-policy.mjs readback
```

readback은 context, 두 Node condition과 cordon taint, ARC spec/status, controller와 scheduler
template, Auth Broker workload, active Pod placement, OOM/eviction event, node/Pod working set을
함께 확인한다. `apply`, `patch`, `cordon`, `uncordon`, `taint`, `delete`는 구현하지 않는다.

## uncordon과 rollback 조건

RPI4 uncordon 또는 ARC capacity/placement 변경은 자동 실행하지 않으며 매 실행별 사람 승인이
필요하다. 다음을 모두 확인한 뒤에만 uncordon을 별도 작업으로 검토한다.

1. cordon `timeAdded` 기준 24시간 이상 관찰
2. `MemoryPressure=False`, 새 OOM/eviction 0건
3. host `MemAvailable` readback으로 실제 고갈이 아님을 재확인
4. scheduler, ARC(arm64 `1/3`·`0/1`, x64 `1/6`·`0/1`), Auth Broker의 exact
   selector/toleration 유지
5. 현재 Pod와 node별 영향 readback 및 사용자 승인

uncordon하더라도 위 세 workload군의 RPI5 selector는 제거하지 않는다. 이후
`MemoryPressure=True`, 새 OOM/eviction, 제한 workload의 RPI4 배치, RPI5 selector 또는 ARC
capacity drift 중 하나가 관찰되면 rollout을 중단하고 현재 상태를 다시 읽은 뒤 RPI4 cordon
복구를 별도 승인 작업으로 수행한다. 자동으로 RPI4에 workload를 우회 배치하지 않는다.
