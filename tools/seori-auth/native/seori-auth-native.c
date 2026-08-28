#define _GNU_SOURCE

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/openat2.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#elif defined(__APPLE__)
#include <sys/ptrace.h>
#include <sys/un.h>
#endif

extern char **environ;

#define PROJECTED_IDENTITY_ROOT "/var/run/seori-auth/projected-identity"
#define PROJECTED_IDENTITY_TOKEN "token"
#define PROJECTED_IDENTITY_FD 4
#define SECRET_MANAGER_NODE "/usr/local/bin/node"
#define SECRET_MANAGER_CHILD "/opt/seori-auth/runtime/secret-manager-child.mjs"
#define PROJECTED_TOKEN_CANARY_CHILD "/opt/seori-auth/runtime/projected-token-canary.mjs"
#define PROCESS_HARDENING_CANARY_CHILD "/opt/seori-auth/runtime/process-hardening-canary.mjs"
#define SECRET_MANAGER_CONFIG_ARG "--config=/etc/seori-auth/secret-access.json"
#define SECRET_MANAGER_RESOURCE_PREFIX "--resource=projects/"

static void fail_closed(const char *message) {
  (void)fprintf(stderr, "seori-auth-native: %s\n", message);
  _exit(126);
}

#if defined(__linux__) && defined(SYS_openat2)
static void fail_projected_token_open(int open_error) {
  if (open_error == ENOSYS || open_error == EINVAL) {
    fail_closed("secure projected identity resolution is unavailable");
  }
  if (open_error == EXDEV) {
    fail_closed("projected identity resolution crossed its trust boundary");
  }
  if (open_error == ELOOP) {
    fail_closed("projected identity resolution encountered an unsafe link");
  }
  fail_closed("unable to securely open projected identity token");
}
#endif

static int resource_segment_character(unsigned char character, int project) {
  return isalnum(character) || character == '_' || character == '-' ||
      (project && (character == '.' || character == ':'));
}

static int valid_secret_resource_argument(const char *value) {
  const size_t prefix_length = strlen(SECRET_MANAGER_RESOURCE_PREFIX);
  const size_t length = strlen(value);
  const char *cursor;
  const char *separator;
  if (
      length <= prefix_length || length > 512 ||
      strncmp(value, SECRET_MANAGER_RESOURCE_PREFIX, prefix_length) != 0) {
    return 0;
  }

  cursor = value + prefix_length;
  separator = strstr(cursor, "/secrets/");
  if (separator == NULL || separator == cursor) {
    return 0;
  }
  for (const char *part = cursor; part < separator; part += 1) {
    if (!resource_segment_character((unsigned char)*part, 1)) {
      return 0;
    }
  }

  cursor = separator + strlen("/secrets/");
  separator = strstr(cursor, "/versions/");
  if (separator == NULL || separator == cursor) {
    return 0;
  }
  for (const char *part = cursor; part < separator; part += 1) {
    if (!resource_segment_character((unsigned char)*part, 0)) {
      return 0;
    }
  }

  cursor = separator + strlen("/versions/");
  if (*cursor < '1' || *cursor > '9') {
    return 0;
  }
  for (; *cursor != '\0'; cursor += 1) {
    if (*cursor < '0' || *cursor > '9') {
      return 0;
    }
  }
  return 1;
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

static int hold_lock(int argc, char **argv) {
  if (argc != 3 || argv[2][0] != '/') {
    fail_closed("hold-lock requires one absolute path");
  }
  harden_process();
  const int flags = O_RDWR | O_CREAT
#if defined(O_NOFOLLOW)
      | O_NOFOLLOW
#endif
      ;
  const int lock_fd = open(argv[2], flags, 0600);
  if (lock_fd < 0) {
    fail_closed("unable to open lock file");
  }
  struct stat state;
  if (fstat(lock_fd, &state) != 0 || !S_ISREG(state.st_mode) ||
      (state.st_mode & 0077) != 0 || state.st_uid != geteuid()) {
    (void)close(lock_fd);
    fail_closed("lock file is not a private owned regular file");
  }
  if (flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
    const int lock_error = errno;
    (void)close(lock_fd);
    if (lock_error == EWOULDBLOCK || lock_error == EAGAIN) {
      _exit(75);
    }
    fail_closed("unable to acquire lock");
  }
  if (printf("{\"locked\":true}\n") < 0 || fflush(stdout) != 0) {
    (void)close(lock_fd);
    fail_closed("unable to report lock acquisition");
  }
  char buffer[64];
  while (read(STDIN_FILENO, buffer, sizeof(buffer)) > 0) {
  }
  (void)flock(lock_fd, LOCK_UN);
  (void)close(lock_fd);
  return 0;
}

static int acquire_lock_fd(int argc) {
  if (argc != 2) {
    fail_closed("acquire-lock-fd takes no path argument");
  }
  harden_process();
  const int lock_fd = 3;
  struct stat state;
  if (fstat(lock_fd, &state) != 0 || !S_ISREG(state.st_mode) ||
      (state.st_mode & 0077) != 0 || state.st_uid != geteuid()) {
    fail_closed("lock descriptor is not a private owned regular file");
  }
  if (flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
    const int lock_error = errno;
    if (lock_error == EWOULDBLOCK || lock_error == EAGAIN) {
      _exit(75);
    }
    fail_closed("unable to acquire descriptor lock");
  }
  if (printf("{\"locked\":true}\n") < 0 || fflush(stdout) != 0) {
    fail_closed("unable to report descriptor lock acquisition");
  }
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

static void bind_projected_identity_token(void) {
#if !defined(__linux__) || !defined(SYS_openat2)
  fail_closed("secure projected token open requires Linux openat2");
#else
  harden_process();
  const int root_fd = open(PROJECTED_IDENTITY_ROOT, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (root_fd < 0) {
    fail_closed("unable to open projected identity mount root");
  }
  struct stat root_state;
  struct statvfs root_filesystem;
  if (
      fstat(root_fd, &root_state) != 0 || !S_ISDIR(root_state.st_mode) ||
      root_state.st_uid != 0 || fstatvfs(root_fd, &root_filesystem) != 0 ||
      (root_filesystem.f_flag & ST_RDONLY) == 0) {
    (void)close(root_fd);
    fail_closed("projected identity mount root is unsafe");
  }
  struct open_how how;
  memset(&how, 0, sizeof(how));
  how.flags = O_RDONLY | O_CLOEXEC;
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV;
  const int token_fd = (int)syscall(
      SYS_openat2, root_fd, PROJECTED_IDENTITY_TOKEN, &how, sizeof(how));
  const int token_open_error = errno;
  (void)close(root_fd);
  if (token_fd < 0) {
    fail_projected_token_open(token_open_error);
  }
  struct stat token_state;
  if (
      fstat(token_fd, &token_state) != 0 || !S_ISREG(token_state.st_mode) ||
      token_state.st_uid != 0 || token_state.st_size < 32 ||
      token_state.st_size > (32 * 1024) || (token_state.st_mode & 0007) != 0 ||
      (token_state.st_mode & 0020) != 0) {
    (void)close(token_fd);
    fail_closed("projected identity token leaf is unsafe");
  }
  if (dup2(token_fd, PROJECTED_IDENTITY_FD) < 0) {
    (void)close(token_fd);
    fail_closed("unable to bind projected identity descriptor");
  }
  if (token_fd != PROJECTED_IDENTITY_FD) {
    (void)close(token_fd);
  }
  const int descriptor_flags = fcntl(PROJECTED_IDENTITY_FD, F_GETFD);
  if (
      descriptor_flags < 0 ||
      fcntl(PROJECTED_IDENTITY_FD, F_SETFD, descriptor_flags & ~FD_CLOEXEC) != 0 ||
      setenv("SEORI_AUTH_SUBJECT_TOKEN_FD", "4", 1) != 0) {
    (void)close(PROJECTED_IDENTITY_FD);
    fail_closed("unable to prepare projected identity descriptor");
  }
#endif
}

static int launch_with_projected_token(int argc, char **argv) {
  if (
      argc != 7 || strcmp(argv[2], "--") != 0 ||
      strcmp(argv[3], SECRET_MANAGER_NODE) != 0 ||
      strcmp(argv[4], SECRET_MANAGER_CHILD) != 0 ||
      strcmp(argv[5], SECRET_MANAGER_CONFIG_ARG) != 0 ||
      !valid_secret_resource_argument(argv[6])) {
    fail_closed("launch-with-projected-token accepts only the fixed Secret Manager child contract");
  }
  bind_projected_identity_token();
  execve(argv[3], &argv[3], environ);
  (void)close(PROJECTED_IDENTITY_FD);
  fail_closed(errno == ENOENT ? "trusted executable does not exist" : "trusted executable failed to start");
  return 126;
}

static int projected_token_self_test(int argc) {
  if (argc != 2) {
    fail_closed("projected-token-self-test takes no arguments");
  }
  bind_projected_identity_token();
  char *const child_argv[] = {
      (char *)SECRET_MANAGER_NODE,
      (char *)PROJECTED_TOKEN_CANARY_CHILD,
      NULL,
  };
  execve(SECRET_MANAGER_NODE, child_argv, environ);
  (void)close(PROJECTED_IDENTITY_FD);
  fail_closed(errno == ENOENT ? "trusted executable does not exist" : "trusted executable failed to start");
  return 126;
}

static int process_hardening_self_test(int argc) {
  if (argc != 2) {
    fail_closed("process-hardening-self-test takes no arguments");
  }
  harden_process();
  char *const child_argv[] = {
      (char *)SECRET_MANAGER_NODE,
      (char *)PROCESS_HARDENING_CANARY_CHILD,
      NULL,
  };
  execve(SECRET_MANAGER_NODE, child_argv, environ);
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
  if (argc >= 2 && strcmp(argv[1], "hold-lock") == 0) {
    return hold_lock(argc, argv);
  }
  if (argc >= 2 && strcmp(argv[1], "acquire-lock-fd") == 0) {
    return acquire_lock_fd(argc);
  }
  if (argc >= 2 && strcmp(argv[1], "launch") == 0) {
    return launch(argc, argv);
  }
  if (argc >= 2 && strcmp(argv[1], "launch-with-projected-token") == 0) {
    return launch_with_projected_token(argc, argv);
  }
  if (argc >= 2 && strcmp(argv[1], "projected-token-self-test") == 0) {
    return projected_token_self_test(argc);
  }
  if (argc >= 2 && strcmp(argv[1], "process-hardening-self-test") == 0) {
    return process_hardening_self_test(argc);
  }
  fail_closed("unsupported command");
  return 126;
}
