#define _DARWIN_C_SOURCE
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <regex.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <libproc.h>
#include <mach-o/dyld.h>
#include <sys/ptrace.h>
#elif defined(__linux__)
#include <sys/prctl.h>
#endif

#ifndef SSH_PATH
#define SSH_PATH "/usr/bin/ssh"
#endif
#define MAX_PASSWORD 4096
#define MAX_COMMAND 8192

struct password_identity {
  dev_t device;
  ino_t inode;
  off_t size;
  uid_t owner;
  mode_t mode;
};

static void fail_closed(void) { _exit(126); }

static void harden(void) {
  struct rlimit limit = {0, 0};
  if (setrlimit(RLIMIT_CORE, &limit) != 0) fail_closed();
  (void)umask(0077);
  (void)unsetenv("LD_PRELOAD");
  (void)unsetenv("DYLD_INSERT_LIBRARIES");
#if defined(__APPLE__)
  if (ptrace(PT_DENY_ATTACH, 0, 0, 0) != 0) fail_closed();
#elif defined(__linux__)
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail_closed();
#else
#error "stage1 SSH relay supports macOS and Linux only"
#endif
}

static void executable_path(pid_t pid, char *output, size_t size) {
#if defined(__APPLE__)
  if (proc_pidpath(pid, output, (uint32_t)size) <= 0) fail_closed();
#elif defined(__linux__)
  char path[64];
  if (snprintf(path, sizeof(path), "/proc/%ld/exe", (long)pid) <= 0) fail_closed();
  ssize_t count = readlink(path, output, size - 1);
  if (count <= 0 || (size_t)count >= size) fail_closed();
  output[count] = '\0';
#endif
}

static pid_t parent_pid(pid_t pid) {
#if defined(__APPLE__)
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) fail_closed();
  return (pid_t)info.pbi_ppid;
#elif defined(__linux__)
  char path[64];
  char line[256];
  if (snprintf(path, sizeof(path), "/proc/%ld/status", (long)pid) <= 0) fail_closed();
  FILE *stream = fopen(path, "r");
  if (stream == NULL) fail_closed();
  pid_t result = -1;
  while (fgets(line, sizeof(line), stream) != NULL) {
    long parsed = -1;
    if (sscanf(line, "PPid:%ld", &parsed) == 1 && parsed > 0) {
      result = (pid_t)parsed;
      break;
    }
  }
  if (fclose(stream) != 0 || result <= 0) fail_closed();
  return result;
#endif
}

static void self_path(const char *argument_zero, char *output, size_t size) {
#if defined(__APPLE__)
  (void)argument_zero;
  uint32_t wanted = (uint32_t)size;
  if (_NSGetExecutablePath(output, &wanted) != 0) fail_closed();
  char canonical[PATH_MAX];
  if (realpath(output, canonical) == NULL || strlen(canonical) >= size) fail_closed();
  (void)strcpy(output, canonical);
#elif defined(__linux__)
  (void)argument_zero;
  executable_path(getpid(), output, size);
#endif
}

static int open_password(
    const char *path,
    unsigned char *buffer,
    struct password_identity *identity) {
  struct stat before;
  if (path == NULL || path[0] != '/' || lstat(path, &before) != 0 ||
      !S_ISREG(before.st_mode) || S_ISLNK(before.st_mode) || before.st_uid != geteuid() ||
      (before.st_mode & 0077) != 0 || before.st_size < 1 || before.st_size > MAX_PASSWORD) {
    fail_closed();
  }
  int descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat held;
  if (descriptor < 0 || fstat(descriptor, &held) != 0 || held.st_dev != before.st_dev ||
      held.st_ino != before.st_ino || held.st_size != before.st_size) fail_closed();
  ssize_t count = read(descriptor, buffer, MAX_PASSWORD + 1);
  struct stat after;
  if (count < 1 || count > MAX_PASSWORD || fstat(descriptor, &after) != 0 ||
      after.st_dev != held.st_dev || after.st_ino != held.st_ino || after.st_size != held.st_size ||
      close(descriptor) != 0) fail_closed();
  while (count > 0 && (buffer[count - 1] == '\n' || buffer[count - 1] == '\r')) count -= 1;
  if (count < 1 || memchr(buffer, '\0', (size_t)count) != NULL) fail_closed();
  if (identity != NULL) {
    identity->device = held.st_dev;
    identity->inode = held.st_ino;
    identity->size = held.st_size;
    identity->owner = held.st_uid;
    identity->mode = held.st_mode & 07777;
  }
  return (int)count;
}

static void verify_password_identity(const struct password_identity *actual) {
  const char *encoded = getenv("SEORILABS_P2_STAGE1_PASSWORD_IDENTITY");
  unsigned long long device = 0;
  unsigned long long inode = 0;
  long long size = 0;
  unsigned long owner = 0;
  unsigned int mode = 0;
  char trailing = '\0';
  if (encoded == NULL ||
      sscanf(encoded, "%llu:%llu:%lld:%lu:%o%c", &device, &inode, &size, &owner, &mode,
        &trailing) != 5 ||
      (unsigned long long)actual->device != device ||
      (unsigned long long)actual->inode != inode || (long long)actual->size != size ||
      (unsigned long)actual->owner != owner || (unsigned int)actual->mode != mode) {
    fail_closed();
  }
}

static int regex_matches(const char *pattern, const char *value) {
  regex_t expression;
  if (regcomp(&expression, pattern, REG_EXTENDED | REG_NOSUB) != 0) fail_closed();
  int result = regexec(&expression, value, 0, NULL, 0) == 0;
  regfree(&expression);
  return result;
}

static int command_allowed(const char *node, const char *command) {
  if (strlen(command) < 1 || strlen(command) > MAX_COMMAND ||
      strpbrk(command, "\r\n`$;|") != NULL) return 0;
  static const char *patterns[] = {
    "^/usr/bin/install -d -m 0700 /var/tmp/seorilabs-fleet-p2$",
    "^/bin/bash -s -- --archive=/var/tmp/seorilabs-fleet-p2/[a-f0-9]{40}-[a-f0-9]{64}\\.tar --sha=[a-f0-9]{64}$",
    "^/usr/bin/dd of=/var/tmp/seorilabs-fleet-p2/[a-f0-9]{40}-[a-f0-9]{64}\\.tar status=none conv=excl$",
    "^/bin/bash -s -- --payload=/var/tmp/seorilabs-fleet-p2/relay-input-[a-f0-9]{64}\\.payload --sha=[a-f0-9]{64}$",
    "^/bin/bash -c 'umask 077 && exec /usr/bin/dd of=/var/tmp/seorilabs-fleet-p2/relay-input-[a-f0-9]{64}\\.payload status=none conv=excl'$",
    "^sudo -S -p '' /bin/sh -c 'exec /bin/bash /var/tmp/seorilabs-fleet-p2/relay-input-[a-f0-9]{64}\\.payload --host=(rpi5|rpi4001|seori-m6-01) --source-sha=[a-f0-9]{40} --archive=/var/tmp/seorilabs-fleet-p2/[a-f0-9]{40}-[a-f0-9]{64}\\.tar --archive-sha=[a-f0-9]{64} --lock-sha=[a-f0-9]{64} --contract-digest=[a-f0-9]{64} --confirmation=fleet-p2-stage1-bootstrap-source-[A-Za-z0-9-]+-[a-f0-9]{12}-[a-f0-9]{12}-[a-f0-9]{16} </dev/null'$",
    "^sudo -S -p '' /bin/sh -c 'exec /usr/local/libexec/seori-auth-native launch -- /usr/local/bin/node /opt/seorilabs/fleet-p2/[a-f0-9]{40}/scripts/fleet/p2-stage1-tang-backup\\.mjs (plan|backup-state) --server=(rpi4001|seori-m6-01) 3</dev/null </dev/null'$",
    "^sudo -S -p '' /bin/sh -c 'exec /usr/local/libexec/seori-auth-native launch -- /usr/local/bin/node /opt/seorilabs/fleet-p2/[a-f0-9]{40}/scripts/fleet/p2-stage1-tang-backup\\.mjs (backup-verify|verify-existing) --server=(rpi4001|seori-m6-01) --confirmation=fleet-p2-stage1-backup-(rpi4001|seori-m6-01)-[a-f0-9]{16} 3< /var/tmp/seorilabs-fleet-p2/relay-input-[a-f0-9]{64}\\.payload </dev/null'$",
    "^sudo -S -p '' /bin/sh -c 'exec /usr/local/libexec/seori-auth-native launch -- /usr/local/bin/node /opt/seorilabs/fleet-p2/[a-f0-9]{40}/scripts/fleet/p2-stage1-tang-backup\\.mjs install-evidence --server=(rpi4001|seori-m6-01) --confirmation=fleet-p2-stage1-install-evidence-(rpi4001|seori-m6-01)-[a-f0-9]{16} 3< /var/tmp/seorilabs-fleet-p2/relay-input-[a-f0-9]{64}\\.payload </dev/null'$",
    "^sudo -S -p '' /bin/sh -c 'exec /usr/local/libexec/seori-auth-native launch -- /usr/local/bin/node /opt/seorilabs/fleet-p2/[a-f0-9]{40}/scripts/fleet/p2-stage1-tang-backup\\.mjs install-rpi5-evidence --confirmation=fleet-p2-stage1-install-rpi5-evidence-[a-f0-9]{16} 3< /var/tmp/seorilabs-fleet-p2/relay-input-[a-f0-9]{64}\\.payload </dev/null'$",
    "^sudo -S -p '' /bin/sh -c 'exec /usr/local/libexec/seori-auth-native launch -- /usr/local/bin/node /opt/seorilabs/fleet-p2/[a-f0-9]{40}/scripts/fleet/provision-p2-tang-server\\.mjs plan --server=(rpi4001|seori-m6-01) 3</dev/null </dev/null'$",
    "^sudo -S -p '' /bin/sh -c 'exec /usr/local/libexec/seori-auth-native launch -- /usr/local/bin/node /opt/seorilabs/fleet-p2/[a-f0-9]{40}/scripts/fleet/provision-p2-tang-server\\.mjs apply --server=(rpi4001|seori-m6-01) --confirmation=fleet-p2-tang-(rpi4001|seori-m6-01)-[a-f0-9]{12} 3</dev/null </dev/null'$",
    "^sudo -S -p '' /bin/sh -c 'exec /usr/local/libexec/seori-auth-native launch -- /usr/local/bin/node /opt/seorilabs/fleet-p2/[a-f0-9]{40}/scripts/fleet/provision-p2-tang-server\\.mjs readback --server=(rpi4001|seori-m6-01) --backup-attestation=/var/lib/seorilabs/tang-backup-attestations/(rpi4001|seori-m6-01)\\.json 3</dev/null </dev/null'$",
    "^sudo -S -p '' /bin/sh -c 'exec /usr/local/libexec/seori-auth-native launch -- /usr/local/bin/node /opt/seorilabs/fleet-p2/[a-f0-9]{40}/scripts/fleet/provision-p2-host-encryption\\.mjs readback --kubeconfig=/var/snap/microk8s/current/credentials/client\\.config --tang-attestation=/var/lib/seorilabs/tang-backup-attestations/rpi4001\\.json --tang-attestation=/var/lib/seorilabs/tang-backup-attestations/seori-m6-01\\.json 3</dev/null </dev/null'$",
    "^sudo -S -p '' /bin/sh -c 'exec /bin/cat -- /var/backups/seori-auth/tang-v1/(rpi4001|seori-m6-01)\\.(server-keys\\.seori-aes256gcm|live-evidence\\.json) </dev/null'$",
  };
  int matched = 0;
  for (size_t index = 0; index < sizeof(patterns) / sizeof(patterns[0]); index += 1) {
    if (regex_matches(patterns[index], command)) {
      matched = 1;
      break;
    }
  }
  if (!matched) return 0;
  if (strstr(command, "/provision-p2-host-encryption.mjs readback ") != NULL) {
    return strcmp(node, "rpi5") == 0;
  }
  if (strcmp(node, "rpi5") == 0) {
    return strstr(command, "--host=rpi5") != NULL ||
      strstr(command, "install-rpi5-evidence") != NULL ||
      strcmp(command, "/usr/bin/install -d -m 0700 /var/tmp/seorilabs-fleet-p2") == 0 ||
      strstr(command, "/bin/bash -s -- --archive=") == command ||
      strstr(command, "/bin/bash -s -- --payload=") == command ||
      strstr(command, "/usr/bin/dd of=") == command ||
      strstr(command, "/bin/bash -c 'umask 077 && exec /usr/bin/dd of=") == command;
  }
  return strstr(command, node) != NULL ||
    strcmp(command, "/usr/bin/install -d -m 0700 /var/tmp/seorilabs-fleet-p2") == 0 ||
    strstr(command, "/bin/bash -s -- --archive=") == command ||
    strstr(command, "/bin/bash -s -- --payload=") == command ||
    strstr(command, "/usr/bin/dd of=") == command ||
    strstr(command, "/bin/bash -c 'umask 077 && exec /usr/bin/dd of=") == command;
}

static const char *node_ip(const char *node) {
  if (strcmp(node, "rpi5") == 0) return "192.168.0.99";
  if (strcmp(node, "rpi4001") == 0) return "192.168.0.100";
  if (strcmp(node, "seori-m6-01") == 0) return "192.168.0.118";
  fail_closed();
  return NULL;
}

static int askpass(const char *argument_zero) {
  harden();
  pid_t ssh = getppid();
  pid_t relay = parent_pid(ssh);
  char ssh_executable[PATH_MAX];
  char relay_executable[PATH_MAX];
  char current_executable[PATH_MAX];
  executable_path(ssh, ssh_executable, sizeof(ssh_executable));
  executable_path(relay, relay_executable, sizeof(relay_executable));
  self_path(argument_zero, current_executable, sizeof(current_executable));
  if (strcmp(ssh_executable, SSH_PATH) != 0 ||
      strcmp(relay_executable, current_executable) != 0) fail_closed();
  unsigned char password[MAX_PASSWORD + 1];
  struct password_identity identity;
  int count = open_password(
    getenv("SEORILABS_P2_STAGE1_PASSWORD_FILE"), password, &identity);
  verify_password_identity(&identity);
  if (write(STDOUT_FILENO, password, (size_t)count) != count ||
      write(STDOUT_FILENO, "\n", 1) != 1) fail_closed();
  memset(password, 0, sizeof(password));
  return 0;
}

static void copy_payload(int output) {
  unsigned char buffer[8192];
  for (;;) {
    ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (count < 0) fail_closed();
    if (count == 0) break;
    ssize_t offset = 0;
    while (offset < count) {
      ssize_t written = write(output, buffer + offset, (size_t)(count - offset));
      if (written <= 0) fail_closed();
      offset += written;
    }
  }
  memset(buffer, 0, sizeof(buffer));
}

static void require_empty_privileged_payload(void) {
  unsigned char byte = 0;
  ssize_t count = read(STDIN_FILENO, &byte, 1);
  byte = 0;
  if (count != 0) fail_closed();
}

static int relay(int argc, char **argv) {
  if (argc != 6 || (strcmp(argv[4], "0") != 0 && strcmp(argv[4], "1") != 0) ||
      !command_allowed(argv[2], argv[5])) fail_closed();
  const int privileged = strcmp(argv[4], "1") == 0;
  const char *sudo_prefix = "sudo -S -p '' ";
  const int command_requires_sudo = strncmp(argv[5], sudo_prefix, strlen(sudo_prefix)) == 0;
  if (privileged != command_requires_sudo) fail_closed();
  harden();
  unsigned char password[MAX_PASSWORD + 1];
  struct password_identity identity;
  int password_count = open_password(argv[3], password, &identity);
  int input_pipe[2];
  if (pipe(input_pipe) != 0) fail_closed();
  char self[PATH_MAX];
  self_path(argv[0], self, sizeof(self));
  char encoded_identity[256];
  if (snprintf(encoded_identity, sizeof(encoded_identity), "%llu:%llu:%lld:%lu:%o",
      (unsigned long long)identity.device, (unsigned long long)identity.inode,
      (long long)identity.size, (unsigned long)identity.owner,
      (unsigned int)identity.mode) <= 0) fail_closed();
  if (setenv("SSH_ASKPASS", self, 1) != 0 || setenv("SSH_ASKPASS_REQUIRE", "force", 1) != 0 ||
      setenv("DISPLAY", "seorilabs-stage1", 1) != 0 ||
      setenv("SEORILABS_P2_STAGE1_PASSWORD_FILE", argv[3], 1) != 0 ||
      setenv("SEORILABS_P2_STAGE1_PASSWORD_IDENTITY", encoded_identity, 1) != 0) fail_closed();
  char destination[64];
  if (snprintf(destination, sizeof(destination), "erani@%s", node_ip(argv[2])) <= 0) fail_closed();
  pid_t child = fork();
  if (child < 0) fail_closed();
  if (child == 0) {
    (void)close(input_pipe[1]);
    if (dup2(input_pipe[0], STDIN_FILENO) < 0) _exit(126);
    (void)close(input_pipe[0]);
    int sink = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (sink < 0 || dup2(sink, STDERR_FILENO) < 0) _exit(126);
    char *const arguments[] = {
      (char *)SSH_PATH, (char *)"-o", (char *)"StrictHostKeyChecking=yes",
      (char *)"-o", (char *)"LogLevel=ERROR", (char *)"-o", (char *)"BatchMode=no",
      (char *)"-o", (char *)"PasswordAuthentication=yes", (char *)"-o",
      (char *)"KbdInteractiveAuthentication=no", (char *)"-o",
      (char *)"NumberOfPasswordPrompts=1", destination, argv[5], NULL,
    };
    execv(SSH_PATH, arguments);
    _exit(126);
  }
  (void)close(input_pipe[0]);
  if (privileged &&
      (write(input_pipe[1], password, (size_t)password_count) != password_count ||
       write(input_pipe[1], "\n", 1) != 1)) fail_closed();
  memset(password, 0, sizeof(password));
  if (privileged) require_empty_privileged_payload();
  else copy_payload(input_pipe[1]);
  if (close(input_pipe[1]) != 0) fail_closed();
  int status = 0;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    fail_closed();
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "relay") == 0) return relay(argc, argv);
  return askpass(argv[0]);
}
