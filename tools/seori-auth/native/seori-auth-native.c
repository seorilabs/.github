#define _GNU_SOURCE

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
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
#include <CommonCrypto/CommonDigest.h>
#include <mach-o/dyld.h>
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
#define NATIVE_LAUNCH_MARKER "SEORI_AUTH_NATIVE_LAUNCHED"
#define PROCESS_BOUNDARY_FD_MARKER "SEORI_AUTH_PROCESS_BOUNDARY_FD"
#define PROCESS_BOUNDARY_FD 5
#define LOCAL_CONTROLLER_FD_MARKER "SEORI_AUTH_LOCAL_CONTROLLER_FD"
#define LOCAL_CONTROLLER_FD 6
#define LOCAL_SOURCE_RECEIPT_FD_MARKER "SEORI_AUTH_LOCAL_SOURCE_RECEIPT_FD"
#define LOCAL_SOURCE_RECEIPT_FD 7
#define LOCAL_SOURCE_SHA_MARKER "SEORI_AUTH_LOCAL_SOURCE_SHA"
#define LOCAL_CONTROLLER_SHA256_MARKER "SEORI_AUTH_LOCAL_CONTROLLER_SHA256"
#define LOCAL_SOURCE_RECEIPT_SHA256_MARKER "SEORI_AUTH_LOCAL_SOURCE_RECEIPT_SHA256"
#define LOCAL_LAUNCHER_PREFIX "seori-auth-native-"
#define LOCAL_MODULE_PREFIX "seorilabs-p2-process-hardening.node-"
#define LOCAL_SOURCE_RECEIPT_LEAF "stage1-local-source.json"
#define LOCAL_CONTROLLER_RELATIVE "scripts/fleet/provision-p2-stage1.mjs"
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
  if (setenv(NATIVE_LAUNCH_MARKER, "1", 1) != 0) {
    fail_closed("unable to attest native launch ancestry");
  }
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

#if defined(__APPLE__)
static int protected_descriptor(int descriptor) {
  if (descriptor < 0) {
    fail_closed("local process boundary descriptor open failed");
  }
  if (descriptor >= 10) return descriptor;
  int protected = fcntl(descriptor, F_DUPFD_CLOEXEC, 10);
  if (protected < 0 || close(descriptor) != 0) {
    if (protected >= 0) (void)close(protected);
    fail_closed("local process boundary descriptor protection failed");
  }
  return protected;
}

static void require_local_directory(int descriptor, uid_t user, mode_t exact_mode) {
  struct stat entry;
  if (
      descriptor < 0 || fstat(descriptor, &entry) != 0 || !S_ISDIR(entry.st_mode) ||
      entry.st_uid != user || (entry.st_mode & 07777) != exact_mode) {
    fail_closed("local process boundary directory is invalid");
  }
}

static void require_safe_home_component(int descriptor, uid_t user) {
  struct stat entry;
  if (
      descriptor < 0 || fstat(descriptor, &entry) != 0 || !S_ISDIR(entry.st_mode) ||
      (entry.st_uid != 0 && entry.st_uid != user) || (entry.st_mode & 0022) != 0) {
    fail_closed("local process boundary home path is invalid");
  }
}

static int open_safe_home_directory(const char *home, uid_t user) {
  if (home == NULL || home[0] != '/' || strlen(home) >= PATH_MAX) {
    fail_closed("local process boundary home is invalid");
  }
  int descriptor = protected_descriptor(
      open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  require_safe_home_component(descriptor, user);
  const char *cursor = home + 1;
  while (*cursor != '\0') {
    const char *separator = strchr(cursor, '/');
    size_t length = separator == NULL ? strlen(cursor) : (size_t)(separator - cursor);
    char component[NAME_MAX + 1];
    if (length == 0 || length > NAME_MAX ||
        (length == 1 && cursor[0] == '.') ||
        (length == 2 && cursor[0] == '.' && cursor[1] == '.')) {
      (void)close(descriptor);
      fail_closed("local process boundary home component is invalid");
    }
    (void)memcpy(component, cursor, length);
    component[length] = '\0';
    int next = protected_descriptor(openat(
        descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    require_safe_home_component(next, user);
    if (close(descriptor) != 0) {
      (void)close(next);
      fail_closed("local process boundary home component close failed");
    }
    descriptor = next;
    if (separator == NULL) break;
    cursor = separator + 1;
    if (*cursor == '\0') {
      (void)close(descriptor);
      fail_closed("local process boundary home has a trailing separator");
    }
  }
  struct stat home_entry;
  if (fstat(descriptor, &home_entry) != 0 || home_entry.st_uid != user) {
    (void)close(descriptor);
    fail_closed("local process boundary home owner is invalid");
  }
  return descriptor;
}

static int open_local_directory(
    int parent, const char *leaf, uid_t user, mode_t exact_mode) {
  int descriptor = protected_descriptor(openat(
      parent, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  require_local_directory(descriptor, user, exact_mode);
  return descriptor;
}

static int open_safe_local_ancestor(int parent, const char *leaf, uid_t user) {
  int descriptor = protected_descriptor(openat(
      parent, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  require_safe_home_component(descriptor, user);
  return descriptor;
}

static void current_home(char output[PATH_MAX]) {
#if defined(SEORI_AUTH_LOCAL_BOUNDARY_TEST_HOME)
  const char *home = SEORI_AUTH_LOCAL_BOUNDARY_TEST_HOME;
#else
  struct passwd password;
  struct passwd *result = NULL;
  char buffer[16384];
  if (getpwuid_r(geteuid(), &password, buffer, sizeof(buffer), &result) != 0 ||
      result == NULL || result->pw_dir == NULL) {
    fail_closed("unable to resolve local process boundary home");
  }
  const char *home = result->pw_dir;
#endif
  int length = snprintf(output, PATH_MAX, "%s", home);
  if (length <= 1 || length >= PATH_MAX || output[0] != '/') {
    fail_closed("local process boundary home is invalid");
  }
}

static void expected_local_execution_paths(
    const char *home, const char *source_sha,
    char node[PATH_MAX], char controller[PATH_MAX]) {
#if defined(SEORI_AUTH_LOCAL_BOUNDARY_TEST_NODE)
  const char *expected_node = SEORI_AUTH_LOCAL_BOUNDARY_TEST_NODE;
#else
  char node_value[PATH_MAX];
  int node_value_length = snprintf(
      node_value, sizeof(node_value),
      "%s/.nvm/versions/node/v24.16.0/bin/node", home);
  if (node_value_length <= 1 || node_value_length >= (int)sizeof(node_value)) {
    fail_closed("local Node path construction failed");
  }
  const char *expected_node = node_value;
#endif
  int node_length = snprintf(node, PATH_MAX, "%s", expected_node);
  int controller_length = snprintf(
      controller, PATH_MAX,
      "%s/.local/share/seorilabs/fleet-p2/%s/%s",
      home, source_sha, LOCAL_CONTROLLER_RELATIVE);
  if (
      node_length <= 1 || node_length >= PATH_MAX || node[0] != '/' ||
      controller_length <= 1 || controller_length >= PATH_MAX || controller[0] != '/') {
    fail_closed("local controller execution path is invalid");
  }
}

static int lowercase_hex(const char *value, size_t length) {
  if (value == NULL || strlen(value) != length) return 0;
  for (size_t index = 0; index < length; index += 1) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  }
  return 1;
}

static void sha256_descriptor(int descriptor, char output[65]) {
  CC_SHA256_CTX context;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  unsigned char buffer[64 * 1024];
  off_t offset = 0;
  if (CC_SHA256_Init(&context) != 1) {
    fail_closed("local process boundary digest initialization failed");
  }
  for (;;) {
    ssize_t length = pread(descriptor, buffer, sizeof(buffer), offset);
    if (length < 0) {
      fail_closed("local process boundary artifact read failed");
    }
    if (length == 0) break;
    if (CC_SHA256_Update(&context, buffer, (CC_LONG)length) != 1) {
      fail_closed("local process boundary digest update failed");
    }
    offset += length;
  }
  (void)memset(buffer, 0, sizeof(buffer));
  if (CC_SHA256_Final(digest, &context) != 1) {
    fail_closed("local process boundary digest finalization failed");
  }
  static const char alphabet[] = "0123456789abcdef";
  for (size_t index = 0; index < sizeof(digest); index += 1) {
    output[index * 2] = alphabet[digest[index] >> 4];
    output[(index * 2) + 1] = alphabet[digest[index] & 0x0f];
  }
  output[64] = '\0';
  (void)memset(digest, 0, sizeof(digest));
  (void)memset(&context, 0, sizeof(context));
}

static int running_executable_descriptor(void) {
  char executable[PATH_MAX];
  char canonical[PATH_MAX];
  uint32_t size = (uint32_t)sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0 || realpath(executable, canonical) == NULL) {
    fail_closed("unable to resolve running local launcher");
  }
  return protected_descriptor(open(canonical, O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
}

static void require_local_regular_file(
    int descriptor, uid_t user, mode_t exact_mode, off_t maximum, struct stat *entry) {
  if (
      descriptor < 0 || fstat(descriptor, entry) != 0 || !S_ISREG(entry->st_mode) ||
      entry->st_uid != user || (entry->st_mode & 07777) != exact_mode ||
      entry->st_nlink != 1 || entry->st_size < 1 || entry->st_size > maximum) {
    fail_closed("local process boundary artifact identity is invalid");
  }
}

static void bind_inherited_descriptor(
    int source, int target, const struct stat *expected, const char *marker,
    const char *marker_value) {
  if (dup2(source, target) != target) {
    fail_closed("unable to bind local process boundary descriptor");
  }
  int descriptor_flags = fcntl(target, F_GETFD);
  struct stat actual;
  if (
      descriptor_flags < 0 ||
      fcntl(target, F_SETFD, descriptor_flags & ~FD_CLOEXEC) != 0 ||
      fstat(target, &actual) != 0 || actual.st_dev != expected->st_dev ||
      actual.st_ino != expected->st_ino || actual.st_size != expected->st_size ||
      setenv(marker, marker_value, 1) != 0) {
    fail_closed("local process boundary descriptor readback failed");
  }
}

static void close_local_descriptor(int descriptor, int *failure) {
  if (descriptor >= 0 && close(descriptor) != 0) *failure = 1;
}

static void bind_local_process_boundary(
    const char *home, const char *source_sha,
    const char *controller_sha256, const char *receipt_sha256) {
  const uid_t user = geteuid();
  int home_directory = open_safe_home_directory(home, user);
  int config_directory = protected_descriptor(openat(
      home_directory, ".config", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  require_safe_home_component(config_directory, user);
  int credential_directory = open_local_directory(config_directory, "seorilabs", user, 0700);
  int binary_directory = open_local_directory(credential_directory, "bin", user, 0700);
  int local_directory = open_safe_local_ancestor(home_directory, ".local", user);
  int share_directory = open_safe_local_ancestor(local_directory, "share", user);
  int runtime_directory = open_local_directory(share_directory, "seorilabs", user, 0700);
  int fleet_directory = open_local_directory(runtime_directory, "fleet-p2", user, 0700);
  int source_directory = open_local_directory(fleet_directory, source_sha, user, 0700);
  int scripts_directory = open_local_directory(source_directory, "scripts", user, 0700);
  int controller_directory = open_local_directory(scripts_directory, "fleet", user, 0700);

  char launcher_leaf[sizeof(LOCAL_LAUNCHER_PREFIX) + 40];
  char module_leaf[sizeof(LOCAL_MODULE_PREFIX) + 40];
  int launcher_length =
      snprintf(launcher_leaf, sizeof(launcher_leaf), "%s%s", LOCAL_LAUNCHER_PREFIX, source_sha);
  int module_length =
      snprintf(module_leaf, sizeof(module_leaf), "%s%s", LOCAL_MODULE_PREFIX, source_sha);
  if (
      launcher_length < 0 || (size_t)launcher_length != sizeof(launcher_leaf) - 1 ||
      module_length < 0 || (size_t)module_length != sizeof(module_leaf) - 1) {
    fail_closed("local process boundary artifact path is invalid");
  }
  int installed_launcher = protected_descriptor(openat(
      binary_directory, launcher_leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
  int running_launcher = running_executable_descriptor();
  int module = protected_descriptor(openat(
      binary_directory, module_leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
  int controller = protected_descriptor(openat(
      controller_directory, "provision-p2-stage1.mjs",
      O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
  int receipt = protected_descriptor(openat(
      source_directory, LOCAL_SOURCE_RECEIPT_LEAF,
      O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
  struct stat installed_entry;
  struct stat running_entry;
  struct stat module_entry;
  struct stat controller_entry;
  struct stat receipt_entry;
  require_local_regular_file(
      installed_launcher, user, 0500, 8 * 1024 * 1024, &installed_entry);
  require_local_regular_file(
      running_launcher, user, 0500, 8 * 1024 * 1024, &running_entry);
  require_local_regular_file(module, user, 0400, 8 * 1024 * 1024, &module_entry);
  require_local_regular_file(controller, user, 0400, 8 * 1024 * 1024, &controller_entry);
  require_local_regular_file(receipt, user, 0400, 64 * 1024, &receipt_entry);
  if (
      installed_entry.st_dev != running_entry.st_dev ||
      installed_entry.st_ino != running_entry.st_ino) {
    fail_closed("running local launcher does not match the installed launcher");
  }
  char actual_controller_sha256[65];
  char actual_receipt_sha256[65];
  sha256_descriptor(controller, actual_controller_sha256);
  sha256_descriptor(receipt, actual_receipt_sha256);
  if (
      strcmp(actual_controller_sha256, controller_sha256) != 0 ||
      strcmp(actual_receipt_sha256, receipt_sha256) != 0) {
    fail_closed("local process boundary artifact digest is invalid");
  }
  (void)memset(actual_controller_sha256, 0, sizeof(actual_controller_sha256));
  (void)memset(actual_receipt_sha256, 0, sizeof(actual_receipt_sha256));

  bind_inherited_descriptor(
      module, PROCESS_BOUNDARY_FD, &module_entry, PROCESS_BOUNDARY_FD_MARKER, "5");
  bind_inherited_descriptor(
      controller, LOCAL_CONTROLLER_FD, &controller_entry, LOCAL_CONTROLLER_FD_MARKER, "6");
  bind_inherited_descriptor(
      receipt, LOCAL_SOURCE_RECEIPT_FD, &receipt_entry,
      LOCAL_SOURCE_RECEIPT_FD_MARKER, "7");
  if (
      setenv(LOCAL_SOURCE_SHA_MARKER, source_sha, 1) != 0 ||
      setenv(LOCAL_CONTROLLER_SHA256_MARKER, controller_sha256, 1) != 0 ||
      setenv(LOCAL_SOURCE_RECEIPT_SHA256_MARKER, receipt_sha256, 1) != 0) {
    fail_closed("local process boundary source binding failed");
  }

  int close_failure = 0;
  close_local_descriptor(home_directory, &close_failure);
  close_local_descriptor(config_directory, &close_failure);
  close_local_descriptor(credential_directory, &close_failure);
  close_local_descriptor(binary_directory, &close_failure);
  close_local_descriptor(local_directory, &close_failure);
  close_local_descriptor(share_directory, &close_failure);
  close_local_descriptor(runtime_directory, &close_failure);
  close_local_descriptor(fleet_directory, &close_failure);
  close_local_descriptor(source_directory, &close_failure);
  close_local_descriptor(scripts_directory, &close_failure);
  close_local_descriptor(controller_directory, &close_failure);
  close_local_descriptor(installed_launcher, &close_failure);
  close_local_descriptor(running_launcher, &close_failure);
  close_local_descriptor(module, &close_failure);
  close_local_descriptor(controller, &close_failure);
  close_local_descriptor(receipt, &close_failure);
  if (close_failure != 0) {
    fail_closed("local process boundary descriptor close failed");
  }
}

static const char *option_value(const char *argument, const char *prefix) {
  size_t prefix_length = strlen(prefix);
  if (strncmp(argument, prefix, prefix_length) != 0) return NULL;
  return argument + prefix_length;
}

static int launch_local_controller(int argc, char **argv) {
  const char *source_sha = argc >= 6 ? option_value(argv[2], "--source-sha=") : NULL;
  const char *controller_sha256 =
      argc >= 6 ? option_value(argv[3], "--controller-sha256=") : NULL;
  const char *receipt_sha256 =
      argc >= 6 ? option_value(argv[4], "--receipt-sha256=") : NULL;
  if (
      argc < 8 || !lowercase_hex(source_sha, 40) ||
      !lowercase_hex(controller_sha256, 64) || !lowercase_hex(receipt_sha256, 64) ||
      strcmp(argv[5], "--") != 0) {
    fail_closed("launch-local-controller source binding is invalid");
  }
  char home[PATH_MAX];
  char expected_node[PATH_MAX];
  char expected_controller[PATH_MAX];
  current_home(home);
  expected_local_execution_paths(home, source_sha, expected_node, expected_controller);
  if (
      strcmp(argv[6], expected_node) != 0 || strcmp(argv[7], expected_controller) != 0) {
    fail_closed("launch-local-controller requires the exact Node and runtime controller paths");
  }
  harden_process();
  bind_local_process_boundary(home, source_sha, controller_sha256, receipt_sha256);
  execve(argv[6], &argv[6], environ);
  (void)close(PROCESS_BOUNDARY_FD);
  (void)close(LOCAL_CONTROLLER_FD);
  (void)close(LOCAL_SOURCE_RECEIPT_FD);
  fail_closed(errno == ENOENT ? "trusted local controller does not exist" :
      "trusted local controller failed to start");
  return 126;
}
#else
static int launch_local_controller(int argc, char **argv) {
  (void)argc;
  (void)argv;
  fail_closed("launch-local-controller is available only on macOS");
  return 126;
}
#endif

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
      token_state.st_size > (32 * 1024) || (token_state.st_mode & 0037) != 0) {
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
  if (argc >= 2 && strcmp(argv[1], "launch-local-controller") == 0) {
    return launch_local_controller(argc, argv);
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
