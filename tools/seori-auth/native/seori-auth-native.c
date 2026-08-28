#define _GNU_SOURCE

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__linux__)
#include <sys/prctl.h>
#elif defined(__APPLE__)
#include <sys/ptrace.h>
#include <sys/un.h>
#endif

extern char **environ;

static void fail_closed(const char *message) {
  (void)fprintf(stderr, "seori-auth-native: %s\n", message);
  _exit(126);
}

static void harden_process(void) {
  struct rlimit core_limit = {0, 0};
  if (setrlimit(RLIMIT_CORE, &core_limit) != 0) {
    fail_closed("unable to disable core dumps");
  }

  (void)umask(0077);
  (void)unsetenv("LD_PRELOAD");
  (void)unsetenv("DYLD_INSERT_LIBRARIES");
  (void)unsetenv("NODE_OPTIONS");

#if defined(__linux__)
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    fail_closed("unable to disable process dumpability");
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fail_closed("unable to set no-new-privileges");
  }
#elif defined(__APPLE__)
  if (ptrace(PT_DENY_ATTACH, 0, 0, 0) != 0) {
    fail_closed("unable to deny debugger attachment");
  }
#else
#error "seori-auth-native supports only Linux and macOS"
#endif
}

static int peer_credential(void) {
  const int peer_fd = 3;
  uid_t uid = 0;
  gid_t gid = 0;
  pid_t pid = 0;

#if defined(__linux__)
  struct ucred credential;
  socklen_t length = (socklen_t)sizeof(credential);
  memset(&credential, 0, sizeof(credential));
  if (getsockopt(peer_fd, SOL_SOCKET, SO_PEERCRED, &credential, &length) != 0 ||
      length != sizeof(credential) || credential.pid <= 0) {
    fail_closed("unable to attest Unix peer credentials");
  }
  uid = credential.uid;
  gid = credential.gid;
  pid = credential.pid;
#elif defined(__APPLE__)
  if (getpeereid(peer_fd, &uid, &gid) != 0) {
    fail_closed("unable to attest Unix peer identity");
  }
#if defined(LOCAL_PEERPID)
  socklen_t length = (socklen_t)sizeof(pid);
  if (getsockopt(peer_fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) != 0 ||
      length != sizeof(pid) || pid <= 0) {
    fail_closed("unable to attest Unix peer process");
  }
#else
  fail_closed("LOCAL_PEERPID is unavailable");
#endif
#endif

  if (printf("{\"uid\":%lu,\"gid\":%lu,\"pid\":%ld}\n",
             (unsigned long)uid, (unsigned long)gid, (long)pid) < 0) {
    fail_closed("unable to report peer attestation");
  }
  return 0;
}

static int self_test(void) {
  harden_process();
  struct rlimit core_limit;
  if (getrlimit(RLIMIT_CORE, &core_limit) != 0) {
    fail_closed("unable to read core dump limit");
  }

#if defined(__linux__)
  const int dumpable = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
  if (dumpable < 0) {
    fail_closed("unable to read process dumpability");
  }
  (void)printf("{\"platform\":\"linux\",\"coreSoft\":%llu,\"coreHard\":%llu,\"dumpable\":%d}\n",
               (unsigned long long)core_limit.rlim_cur,
               (unsigned long long)core_limit.rlim_max,
               dumpable);
#elif defined(__APPLE__)
  (void)printf("{\"platform\":\"macos\",\"coreSoft\":%llu,\"coreHard\":%llu,\"denyAttach\":true}\n",
               (unsigned long long)core_limit.rlim_cur,
               (unsigned long long)core_limit.rlim_max);
#endif
  return 0;
}

static int launch(int argc, char **argv) {
  if (argc < 4 || strcmp(argv[2], "--") != 0 || argv[3][0] != '/') {
    fail_closed("launch requires an absolute executable after --");
  }
  harden_process();
  execve(argv[3], &argv[3], environ);
  fail_closed(errno == ENOENT ? "trusted executable does not exist" : "trusted executable failed to start");
  return 126;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "peer-credential") == 0) {
    return peer_credential();
  }
  if (argc == 2 && strcmp(argv[1], "self-test") == 0) {
    return self_test();
  }
  if (argc >= 2 && strcmp(argv[1], "launch") == 0) {
    return launch(argc, argv);
  }
  fail_closed("unsupported command");
  return 126;
}
