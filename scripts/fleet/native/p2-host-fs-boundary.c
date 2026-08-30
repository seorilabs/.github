#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/fs.h>
#include <linux/magic.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <sys/wait.h>
#endif

#if defined(SEORILABS_P2_TEST_ROOT)
#define SOURCE_PARENT SEORILABS_P2_TEST_ROOT "/data/seori-auth"
#define ROLLBACK_PARENT SEORILABS_P2_TEST_ROOT "/data/seori-auth/rollback"
#define BACKUP_PARENT SEORILABS_P2_TEST_ROOT "/var/backups/seori-auth/fleet-p2-host-v1"
#define MARKER_PARENT SEORILABS_P2_TEST_ROOT "/var/lib/seori-auth"
#define ETC_PARENT SEORILABS_P2_TEST_ROOT "/etc"
#define SYSTEMD_SYSTEM_PARENT SEORILABS_P2_TEST_ROOT "/etc/systemd/system"
#define VAR_BACKUPS_PARENT SEORILABS_P2_TEST_ROOT "/var/backups"
#define VAR_LIB_PARENT SEORILABS_P2_TEST_ROOT "/var/lib"
#else
#define SOURCE_PARENT "/data/seori-auth"
#define ROLLBACK_PARENT "/data/seori-auth/rollback"
#define BACKUP_PARENT "/var/backups/seori-auth/fleet-p2-host-v1"
#define MARKER_PARENT "/var/lib/seori-auth"
#define ETC_PARENT "/etc"
#define SYSTEMD_SYSTEM_PARENT "/etc/systemd/system"
#define VAR_BACKUPS_PARENT "/var/backups"
#define VAR_LIB_PARENT "/var/lib"
#endif

#define SOURCE_LEAF "seori-auth-state.luks"
#define ROLLBACK_LEAF "seori-auth-state.luks"
#define HEADER_LEAF "luks-header.bin"
#define SOURCE_PATH SOURCE_PARENT "/" SOURCE_LEAF
#define SOURCE_SIZE ((off_t)17179869184LL)
#define CRYPTSETUP "/usr/sbin/cryptsetup"
#define HOST_RECORD_MAX_SIZE ((size_t)524288)
#define STAGE1_ARTIFACT_MAX_SIZE ((size_t)4194304)
#define STAGE1_EVIDENCE_MAX_SIZE ((size_t)1048576)
#define TRUST_ANCHOR_MAX_SIZE ((size_t)16384)

static void fail_closed(const char *reason) {
  (void)fprintf(stderr, "seorilabs-p2-host-fs-boundary: %s\n", reason);
  _exit(126);
}

#if defined(__linux__) && defined(SYS_renameat2)
static size_t read_proc_identity(const char *path, char *buffer, size_t capacity) {
  int descriptor = open(path, O_RDONLY | O_CLOEXEC);
  if (descriptor < 0 || capacity < 2) fail_closed("host PID 1 identity read failed");
  size_t total = 0;
  while (total < capacity - 1) {
    ssize_t count = read(descriptor, buffer + total, capacity - 1 - total);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) {
      (void)close(descriptor);
      fail_closed("host PID 1 identity read failed");
    }
    if (count == 0) break;
    total += (size_t)count;
  }
  unsigned char overflow;
  ssize_t extra;
  do {
    extra = read(descriptor, &overflow, 1);
  } while (extra < 0 && errno == EINTR);
  if (extra != 0 || close(descriptor) != 0) {
    fail_closed("host PID 1 identity is invalid");
  }
  buffer[total] = '\0';
  return total;
}

static void require_initial_mount_namespace(void) {
  int initial = open("/proc/1/ns/mnt", O_RDONLY | O_CLOEXEC);
  int current = open("/proc/self/ns/mnt", O_RDONLY | O_CLOEXEC);
  int root = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  int initial_root = open("/proc/1/root", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  struct stat initial_entry;
  struct stat current_entry;
  struct stat root_entry;
  struct stat initial_root_entry;
  struct statfs initial_filesystem;
  struct statfs current_filesystem;
  if (initial < 0 || current < 0 || root < 0 || initial_root < 0 ||
      fstat(initial, &initial_entry) != 0 ||
      fstat(current, &current_entry) != 0 || fstatfs(initial, &initial_filesystem) != 0 ||
      fstatfs(current, &current_filesystem) != 0 ||
      fstat(root, &root_entry) != 0 || fstat(initial_root, &initial_root_entry) != 0 ||
      initial_filesystem.f_type != NSFS_MAGIC || current_filesystem.f_type != NSFS_MAGIC ||
      initial_entry.st_dev != current_entry.st_dev || initial_entry.st_ino != current_entry.st_ino ||
      root_entry.st_dev != initial_root_entry.st_dev || root_entry.st_ino != initial_root_entry.st_ino) {
    if (initial >= 0) (void)close(initial);
    if (current >= 0) (void)close(current);
    if (root >= 0) (void)close(root);
    if (initial_root >= 0) (void)close(initial_root);
    fail_closed("initial host mount namespace is required");
  }
  int close_failure = 0;
  if (close(initial) != 0) close_failure = 1;
  if (close(current) != 0) close_failure = 1;
  if (close(root) != 0) close_failure = 1;
  if (close(initial_root) != 0) close_failure = 1;
  if (close_failure != 0) {
    fail_closed("mount namespace descriptor close failed");
  }
  char command[32];
  char control_group[8192];
  size_t command_length = read_proc_identity("/proc/1/comm", command, sizeof(command));
  (void)read_proc_identity("/proc/1/cgroup", control_group, sizeof(control_group));
  if (
      command_length != strlen("systemd\n") || strcmp(command, "systemd\n") != 0 ||
      strstr(control_group, "docker") != NULL || strstr(control_group, "kubepods") != NULL ||
      strstr(control_group, "containerd") != NULL || strstr(control_group, "libpod") != NULL ||
      strstr(control_group, "lxc") != NULL) {
    fail_closed("initial host PID 1 identity is required");
  }
}

static int renameat2_exact(
    int old_dir, const char *old_name, int new_dir, const char *new_name,
    unsigned int flags) {
  return (int)syscall(SYS_renameat2, old_dir, old_name, new_dir, new_name, flags);
}

static void require_trusted_directory_descriptor(int descriptor) {
  struct stat entry;
  if (descriptor < 0 || fstat(descriptor, &entry) != 0 || !S_ISDIR(entry.st_mode) ||
      entry.st_uid != 0 || (entry.st_mode & 0022) != 0) {
    fail_closed("trusted directory boundary is invalid");
  }
}

static int open_trusted_directory(const char *path) {
  if (path == NULL || path[0] != '/' || strlen(path) >= PATH_MAX) {
    fail_closed("trusted directory path is invalid");
  }
  int descriptor = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) fail_closed("host root directory boundary is invalid");
  require_trusted_directory_descriptor(descriptor);
  const char *cursor = path + 1;
  while (*cursor != '\0') {
    const char *separator = strchr(cursor, '/');
    size_t length = separator == NULL ? strlen(cursor) : (size_t)(separator - cursor);
    char component[NAME_MAX + 1];
    if (length == 0 || length > NAME_MAX ||
        (length == 1 && cursor[0] == '.') ||
        (length == 2 && cursor[0] == '.' && cursor[1] == '.')) {
      (void)close(descriptor);
      fail_closed("trusted directory component is invalid");
    }
    (void)memcpy(component, cursor, length);
    component[length] = '\0';
    int next = openat(
        descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) {
      (void)close(descriptor);
      fail_closed("trusted directory component open failed");
    }
    require_trusted_directory_descriptor(next);
    if (close(descriptor) != 0) {
      (void)close(next);
      fail_closed("trusted directory component close failed");
    }
    descriptor = next;
    if (separator == NULL) break;
    cursor = separator + 1;
    if (*cursor == '\0') {
      (void)close(descriptor);
      fail_closed("trusted directory path has a trailing separator");
    }
  }
  return descriptor;
}

static int open_or_create_trusted_child_directory(
    int parent, const char *leaf, mode_t mode) {
  int created = 0;
  if (mkdirat(parent, leaf, mode) == 0) {
    created = 1;
  } else if (errno != EEXIST) {
    (void)close(parent);
    fail_closed("managed directory creation failed");
  }
  int directory = openat(
      parent, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat entry;
  if (directory < 0 || (created && fchmod(directory, mode) != 0) ||
      fstat(directory, &entry) != 0 || !S_ISDIR(entry.st_mode) ||
      entry.st_uid != 0 || entry.st_gid != 0 || (entry.st_mode & 07777) != mode) {
    if (directory >= 0) (void)close(directory);
    (void)close(parent);
    fail_closed("managed directory boundary is invalid");
  }
  if ((created && fsync(directory) != 0) || fsync(parent) != 0 || close(parent) != 0) {
    (void)close(directory);
    fail_closed("managed directory sync failed");
  }
  return directory;
}

enum record_parent_policy {
  RECORD_PARENT_EXISTING = 0,
  RECORD_PARENT_TANG_OVERRIDE = 1,
  RECORD_PARENT_STAGE1_BACKUP = 2,
  RECORD_PARENT_TRUST = 3,
  RECORD_PARENT_TANG_ATTESTATION = 4,
  RECORD_PARENT_HOST_BACKUP = 5,
};

static int open_record_directory(int policy, const char *parent) {
  int directory;
  if (policy == RECORD_PARENT_EXISTING) return open_trusted_directory(parent);
  if (policy == RECORD_PARENT_TANG_OVERRIDE) {
    directory = open_trusted_directory(SYSTEMD_SYSTEM_PARENT);
    return open_or_create_trusted_child_directory(directory, "tangd.socket.d", 0755);
  }
  if (policy == RECORD_PARENT_STAGE1_BACKUP) {
    directory = open_trusted_directory(VAR_BACKUPS_PARENT);
    directory = open_or_create_trusted_child_directory(directory, "seori-auth", 0700);
    return open_or_create_trusted_child_directory(directory, "tang-v1", 0700);
  }
  if (policy == RECORD_PARENT_HOST_BACKUP) {
    directory = open_trusted_directory(VAR_BACKUPS_PARENT);
    directory = open_or_create_trusted_child_directory(directory, "seori-auth", 0700);
    return open_or_create_trusted_child_directory(directory, "fleet-p2-host-v1", 0700);
  }
  if (policy == RECORD_PARENT_TRUST) {
    directory = open_trusted_directory(ETC_PARENT);
    directory = open_or_create_trusted_child_directory(directory, "seorilabs", 0755);
    return open_or_create_trusted_child_directory(directory, "trust", 0755);
  }
  if (policy == RECORD_PARENT_TANG_ATTESTATION) {
    directory = open_trusted_directory(VAR_LIB_PARENT);
    directory = open_or_create_trusted_child_directory(directory, "seorilabs", 0700);
    return open_or_create_trusted_child_directory(
        directory, "tang-backup-attestations", 0700);
  }
  fail_closed("record parent policy is invalid");
  return -1;
}

static struct stat open_regular_at(int directory, const char *leaf, int *descriptor) {
  struct stat entry;
  *descriptor = openat(directory, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (*descriptor < 0 || fstat(*descriptor, &entry) != 0 || !S_ISREG(entry.st_mode)) {
    if (*descriptor >= 0) (void)close(*descriptor);
    fail_closed("regular file identity is invalid");
  }
  return entry;
}

static void require_same_entry(int directory, const char *leaf, const struct stat *expected) {
  struct stat current;
  if (fstatat(directory, leaf, &current, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(current.st_mode) || current.st_dev != expected->st_dev ||
      current.st_ino != expected->st_ino) {
    fail_closed("directory entry identity changed");
  }
}

static int descriptor_is_private_backup(int descriptor) {
  struct stat entry;
  return fstat(descriptor, &entry) == 0 && S_ISREG(entry.st_mode) &&
      entry.st_uid == 0 && (entry.st_mode & 0077) == 0;
}

static int files_equal(int left, int right) {
  struct stat left_entry;
  struct stat right_entry;
  unsigned char left_buffer[8192];
  unsigned char right_buffer[8192];
  off_t offset = 0;
  if (fstat(left, &left_entry) != 0 || fstat(right, &right_entry) != 0 ||
      !S_ISREG(left_entry.st_mode) || !S_ISREG(right_entry.st_mode) ||
      left_entry.st_size != right_entry.st_size) return 0;
  while (offset < left_entry.st_size) {
    size_t wanted = sizeof(left_buffer);
    if (left_entry.st_size - offset < (off_t)wanted) {
      wanted = (size_t)(left_entry.st_size - offset);
    }
    ssize_t left_count = pread(left, left_buffer, wanted, offset);
    ssize_t right_count = pread(right, right_buffer, wanted, offset);
    if (left_count != (ssize_t)wanted || right_count != (ssize_t)wanted ||
        memcmp(left_buffer, right_buffer, wanted) != 0) return 0;
    offset += (off_t)wanted;
  }
  return 1;
}

static unsigned long parse_unsigned(const char *value, int base, unsigned long maximum) {
  char *end = NULL;
  errno = 0;
  unsigned long parsed = strtoul(value, &end, base);
  if (errno != 0 || end == value || *end != '\0' || parsed > maximum) {
    fail_closed("numeric argument is invalid");
  }
  return parsed;
}

static void require_metadata(
    const struct stat *entry, uid_t owner, gid_t group, mode_t mode) {
  if (entry->st_uid != owner || entry->st_gid != group ||
      (entry->st_mode & 07777) != mode) {
    fail_closed("configuration metadata is invalid");
  }
}

static void copy_descriptor_to_new_file(
    int source, int directory, const char *leaf, uid_t owner, gid_t group, mode_t mode,
    struct stat *created) {
  unsigned char buffer[8192];
  off_t offset = 0;
  int target = openat(
      directory, leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (target < 0) fail_closed("atomic configuration staging failed");
  for (;;) {
    ssize_t count = pread(source, buffer, sizeof(buffer), offset);
    if (count < 0) fail_closed("configuration backup read failed");
    if (count == 0) break;
    ssize_t written = 0;
    while (written < count) {
      ssize_t result = write(target, buffer + written, (size_t)(count - written));
      if (result <= 0) fail_closed("configuration staging write failed");
      written += result;
    }
    offset += count;
  }
  if (fchown(target, owner, group) != 0 || fchmod(target, mode) != 0 ||
      fsync(target) != 0 || fstat(target, created) != 0 || !S_ISREG(created->st_mode)) {
    fail_closed("configuration staging metadata failed");
  }
  if (close(target) != 0) fail_closed("configuration staging close failed");
}

static void sync_directory(int descriptor) {
  if (fsync(descriptor) != 0) fail_closed("directory sync failed");
}

struct record_specification {
  const char *identifier;
  const char *parent;
  const char *leaf;
  uid_t owner;
  gid_t group;
  mode_t mode;
  size_t max_size;
  int parent_policy;
};

static const struct record_specification RECORDS[] = {
  {"crypttab-before", NULL, "crypttab.before", 0, 0, 0600,
   HOST_RECORD_MAX_SIZE, RECORD_PARENT_HOST_BACKUP},
  {"fstab-before", NULL, "fstab.before", 0, 0, 0600,
   HOST_RECORD_MAX_SIZE, RECORD_PARENT_HOST_BACKUP},
  {"pre-provision", NULL, "pre-provision.json", 0, 0, 0600,
   HOST_RECORD_MAX_SIZE, RECORD_PARENT_HOST_BACKUP},
  {"crypttab-managed", NULL, "crypttab.before.managed", 0, 0, 0600,
   HOST_RECORD_MAX_SIZE, RECORD_PARENT_HOST_BACKUP},
  {"fstab-managed", NULL, "fstab.before.managed", 0, 0, 0600,
   HOST_RECORD_MAX_SIZE, RECORD_PARENT_HOST_BACKUP},
  {"marker", MARKER_PARENT, ".seorilabs-host-encrypted-mount.json", 0, 65532, 0440,
   HOST_RECORD_MAX_SIZE, RECORD_PARENT_EXISTING},
  {"provision", NULL, "provision.json", 0, 0, 0600,
   HOST_RECORD_MAX_SIZE, RECORD_PARENT_HOST_BACKUP},
  {"reboot", NULL, "reboot.json", 0, 0, 0600,
   HOST_RECORD_MAX_SIZE, RECORD_PARENT_HOST_BACKUP},
  {"rollback", NULL, "rollback.json", 0, 0, 0600,
   HOST_RECORD_MAX_SIZE, RECORD_PARENT_HOST_BACKUP},
  {"provision-restored", NULL, "provision.restored.json", 0, 0, 0600,
   HOST_RECORD_MAX_SIZE, RECORD_PARENT_HOST_BACKUP},
  {"reboot-restored", NULL, "reboot.restored.json", 0, 0, 0600,
   HOST_RECORD_MAX_SIZE, RECORD_PARENT_HOST_BACKUP},
  {"tang-socket-override", NULL, "seorilabs.conf", 0, 0, 0644,
   HOST_RECORD_MAX_SIZE, RECORD_PARENT_TANG_OVERRIDE},
  {"backup-artifact-rpi4001", NULL, "rpi4001.server-keys.seori-aes256gcm", 0, 0, 0600,
   STAGE1_ARTIFACT_MAX_SIZE, RECORD_PARENT_STAGE1_BACKUP},
  {"live-evidence-rpi4001", NULL, "rpi4001.live-evidence.json", 0, 0, 0600,
   STAGE1_EVIDENCE_MAX_SIZE, RECORD_PARENT_STAGE1_BACKUP},
  {"backup-artifact-seori-m6-01", NULL, "seori-m6-01.server-keys.seori-aes256gcm", 0, 0, 0600,
   STAGE1_ARTIFACT_MAX_SIZE, RECORD_PARENT_STAGE1_BACKUP},
  {"live-evidence-seori-m6-01", NULL, "seori-m6-01.live-evidence.json", 0, 0, 0600,
   STAGE1_EVIDENCE_MAX_SIZE, RECORD_PARENT_STAGE1_BACKUP},
  {"trust-anchor", NULL, "credential-backup-attestor.ed25519.pem", 0, 0, 0444,
   TRUST_ANCHOR_MAX_SIZE, RECORD_PARENT_TRUST},
  {"tang-attestation-rpi4001", NULL, "rpi4001.json", 0, 0, 0400,
   STAGE1_EVIDENCE_MAX_SIZE, RECORD_PARENT_TANG_ATTESTATION},
  {"tang-attestation-seori-m6-01", NULL, "seori-m6-01.json", 0, 0, 0400,
   STAGE1_EVIDENCE_MAX_SIZE, RECORD_PARENT_TANG_ATTESTATION},
};

static const struct record_specification *record_specification(const char *identifier) {
  size_t count = sizeof(RECORDS) / sizeof(RECORDS[0]);
  for (size_t index = 0; index < count; index += 1) {
    if (strcmp(identifier, RECORDS[index].identifier) == 0) return &RECORDS[index];
  }
  fail_closed("record identifier is not allowlisted");
  return NULL;
}

static int publish_record(const char *identifier) {
  const struct record_specification *record = record_specification(identifier);
  int directory = open_record_directory(record->parent_policy, record->parent);
  struct stat existing;
  if (fstatat(directory, record->leaf, &existing, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
    fail_closed("record destination refused");
  }
  char temporary[96];
  int temporary_length = snprintf(
      temporary, sizeof(temporary), ".seorilabs-p2-record.%ld.tmp", (long)getpid());
  if (temporary_length <= 0 || (size_t)temporary_length >= sizeof(temporary)) {
    fail_closed("record staging name failed");
  }
  int target = openat(
      directory, temporary,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (target < 0) fail_closed("record staging create failed");
  unsigned char buffer[8192];
  size_t total = 0;
  for (;;) {
    ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) fail_closed("record input read failed");
    if (count == 0) break;
    if ((size_t)count > record->max_size - total) fail_closed("record input is too large");
    ssize_t written = 0;
    while (written < count) {
      ssize_t result = write(target, buffer + written, (size_t)(count - written));
      if (result < 0 && errno == EINTR) continue;
      if (result <= 0) fail_closed("record staging write failed");
      written += result;
    }
    total += (size_t)count;
  }
  struct stat target_entry;
  if (fchown(target, record->owner, record->group) != 0 ||
      fchmod(target, record->mode) != 0 || fsync(target) != 0 ||
      fstat(target, &target_entry) != 0 || !S_ISREG(target_entry.st_mode) ||
      target_entry.st_uid != record->owner || target_entry.st_gid != record->group ||
      (target_entry.st_mode & 07777) != record->mode || target_entry.st_size != (off_t)total ||
      target_entry.st_nlink != 1) {
    fail_closed("record staging metadata failed");
  }
  require_same_entry(directory, temporary, &target_entry);
  if (linkat(directory, temporary, directory, record->leaf, 0) != 0) {
    fail_closed("record no-clobber publish failed");
  }
  require_same_entry(directory, record->leaf, &target_entry);
  if (unlinkat(directory, temporary, 0) != 0) fail_closed("record staging unlink failed");
  if (fstatat(directory, temporary, &existing, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT ||
      fstat(target, &target_entry) != 0 || target_entry.st_nlink != 1) {
    fail_closed("record publish readback failed");
  }
  require_same_entry(directory, record->leaf, &target_entry);
  sync_directory(directory);
  if (close(target) != 0 || close(directory) != 0) fail_closed("record close failed");
  (void)printf(
      "{\"operation\":\"publish-record\",\"record\":\"%s\",\"sizeBytes\":%zu}\n",
      record->identifier, total);
  return 0;
}

static int create_source(void) {
  int parent = open_trusted_directory(SOURCE_PARENT);
  int source = openat(
      parent, SOURCE_LEAF,
      O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  struct stat entry;
  if (source < 0) fail_closed("source creation refused");
  int allocation = posix_fallocate(source, 0, SOURCE_SIZE);
  if (allocation != 0 || fsync(source) != 0 || fstat(source, &entry) != 0 ||
      !S_ISREG(entry.st_mode) || entry.st_size != SOURCE_SIZE ||
      entry.st_blocks * 512 < SOURCE_SIZE || entry.st_uid != 0 ||
      entry.st_gid != 0 || (entry.st_mode & 07777) != 0600) {
    fail_closed("non-sparse source allocation failed");
  }
  require_same_entry(parent, SOURCE_LEAF, &entry);
  sync_directory(parent);
  if (close(source) != 0 || close(parent) != 0) fail_closed("source close failed");
  (void)printf("{\"operation\":\"create-source\",\"created\":true}\n");
  return 0;
}

static int backup_header(void) {
  int directory = open_trusted_directory(BACKUP_PARENT);
  struct stat source_entry;
  int source_parent = open_trusted_directory(SOURCE_PARENT);
  int source = -1;
  char temporary[96];
  char child_path[160];
  char source_child_path[64];
  source_entry = open_regular_at(source_parent, SOURCE_LEAF, &source);
  if (source_entry.st_size != SOURCE_SIZE) fail_closed("source identity is invalid");
  if (snprintf(temporary, sizeof(temporary), ".luks-header.%ld.tmp", (long)getpid()) <= 0) {
    fail_closed("header staging name failed");
  }
  int directory_flags = fcntl(directory, F_GETFD);
  int source_flags = fcntl(source, F_GETFD);
  if (directory_flags < 0 || source_flags < 0 ||
      fcntl(directory, F_SETFD, directory_flags & ~FD_CLOEXEC) != 0 ||
      fcntl(source, F_SETFD, source_flags & ~FD_CLOEXEC) != 0 ||
      snprintf(child_path, sizeof(child_path), "/proc/self/fd/%d/%s", directory, temporary) <= 0 ||
      snprintf(source_child_path, sizeof(source_child_path), "/proc/self/fd/%d", source) <= 0) {
    fail_closed("header descriptor setup failed");
  }
  pid_t child = fork();
  if (child < 0) fail_closed("header backup fork failed");
  if (child == 0) {
    int sink = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (sink < 0 || dup2(sink, STDOUT_FILENO) < 0 || dup2(sink, STDERR_FILENO) < 0) {
      _exit(126);
    }
    char *const arguments[] = {
      (char *)CRYPTSETUP, (char *)"luksHeaderBackup", source_child_path,
      (char *)"--header-backup-file", child_path, NULL,
    };
    char *const environment[] = {
      (char *)"PATH=/usr/sbin:/usr/bin:/sbin:/bin", (char *)"LANG=C", (char *)"LC_ALL=C", NULL,
    };
    execve(CRYPTSETUP, arguments, environment);
    _exit(126);
  }
  int status = 0;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    (void)unlinkat(directory, temporary, 0);
    fail_closed("cryptsetup header backup failed");
  }
  require_same_entry(source_parent, SOURCE_LEAF, &source_entry);
  int header = -1;
  struct stat header_entry = open_regular_at(directory, temporary, &header);
  require_same_entry(directory, temporary, &header_entry);
  if (header_entry.st_size <= 0 || fchown(header, 0, 0) != 0 ||
      fchmod(header, 0400) != 0 || fsync(header) != 0 ||
      fstat(header, &header_entry) != 0) {
    fail_closed("header backup metadata failed");
  }
  require_same_entry(directory, temporary, &header_entry);
  if (renameat2_exact(directory, temporary, directory, HEADER_LEAF, RENAME_NOREPLACE) != 0) {
    fail_closed("header backup destination refused");
  }
  require_same_entry(directory, HEADER_LEAF, &header_entry);
  sync_directory(directory);
  if (close(header) != 0 || close(source) != 0 || close(source_parent) != 0 ||
      close(directory) != 0) {
    fail_closed("header backup close failed");
  }
  (void)printf("{\"operation\":\"backup-header\",\"created\":true}\n");
  return 0;
}

static int move_source(int restore) {
  const char *source_parent_path = restore ? ROLLBACK_PARENT : SOURCE_PARENT;
  const char *destination_parent_path = restore ? SOURCE_PARENT : ROLLBACK_PARENT;
  int source_parent = open_trusted_directory(source_parent_path);
  int destination_parent = open_trusted_directory(destination_parent_path);
  int source = -1;
  struct stat source_entry = open_regular_at(source_parent, SOURCE_LEAF, &source);
  struct stat source_parent_entry;
  struct stat destination_parent_entry;
  if (fstat(source_parent, &source_parent_entry) != 0 ||
      fstat(destination_parent, &destination_parent_entry) != 0 ||
      source_entry.st_dev != source_parent_entry.st_dev ||
      source_entry.st_dev != destination_parent_entry.st_dev) {
    fail_closed("cross-filesystem source move refused");
  }
  require_same_entry(source_parent, SOURCE_LEAF, &source_entry);
  if (renameat2_exact(
      source_parent, SOURCE_LEAF, destination_parent, ROLLBACK_LEAF,
      RENAME_NOREPLACE) != 0) {
    fail_closed("atomic source move refused");
  }
  require_same_entry(destination_parent, ROLLBACK_LEAF, &source_entry);
  if (fstatat(source_parent, SOURCE_LEAF, &source_parent_entry, AT_SYMLINK_NOFOLLOW) == 0 ||
      errno != ENOENT) {
    fail_closed("source move readback failed");
  }
  sync_directory(source_parent);
  sync_directory(destination_parent);
  if (close(source) != 0 || close(source_parent) != 0 || close(destination_parent) != 0) {
    fail_closed("source move close failed");
  }
  (void)printf("{\"operation\":\"%s-source\",\"moved\":true}\n",
               restore ? "restore" : "rollback");
  return 0;
}

static void config_names(
    const char *identifier, const char **target, const char **swap, const char **temporary) {
  if (strcmp(identifier, "crypttab") == 0) {
    *target = "crypttab";
    *swap = ".seorilabs-p2-crypttab-original";
    *temporary = ".seorilabs-p2-crypttab-original.tmp";
    return;
  }
  if (strcmp(identifier, "fstab") == 0) {
    *target = "fstab";
    *swap = ".seorilabs-p2-fstab-original";
    *temporary = ".seorilabs-p2-fstab-original.tmp";
    return;
  }
  fail_closed("configuration identifier is invalid");
}

static int entry_exists(int directory, const char *leaf, struct stat *entry) {
  if (fstatat(directory, leaf, entry, AT_SYMLINK_NOFOLLOW) == 0) return 1;
  if (errno == ENOENT) return 0;
  fail_closed("configuration entry readback failed");
  return 0;
}

static void require_file_matches(
    int directory, const char *leaf, int expected_descriptor,
    uid_t owner, gid_t group, mode_t mode) {
  int descriptor = -1;
  struct stat entry = open_regular_at(directory, leaf, &descriptor);
  require_metadata(&entry, owner, group, mode);
  if (!files_equal(descriptor, expected_descriptor)) {
    fail_closed("configuration transition readback drifted");
  }
  require_same_entry(directory, leaf, &entry);
  if (close(descriptor) != 0) fail_closed("configuration readback close failed");
}

static void require_missing_entry(int directory, const char *leaf) {
  struct stat entry;
  if (fstatat(directory, leaf, &entry, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
    fail_closed("configuration entry should be absent");
  }
}

static int config_transition(int argc, char **argv, int transition) {
  if (argc != 7 || (strcmp(argv[3], "0") != 0 && strcmp(argv[3], "1") != 0)) {
    fail_closed("configuration transition arguments are invalid");
  }
  const char *target = NULL;
  const char *swap = NULL;
  const char *temporary = NULL;
  config_names(argv[2], &target, &swap, &temporary);
  const int existed = strcmp(argv[3], "1") == 0;
  uid_t owner = (uid_t)parse_unsigned(argv[4], 10, UINT_MAX);
  gid_t group = (gid_t)parse_unsigned(argv[5], 10, UINT_MAX);
  mode_t mode = (mode_t)parse_unsigned(argv[6], 8, 07777);
  if (!descriptor_is_private_backup(3) || !descriptor_is_private_backup(4)) {
    fail_closed("configuration backup descriptor is invalid");
  }
  int directory = open_trusted_directory(ETC_PARENT);
  struct stat target_entry;
  struct stat swap_entry;
  int target_present = entry_exists(directory, target, &target_entry);
  int swap_present = entry_exists(directory, swap, &swap_entry);
  if ((target_present && !S_ISREG(target_entry.st_mode)) ||
      (swap_present && !S_ISREG(swap_entry.st_mode))) {
    fail_closed("configuration entry type is invalid");
  }

  if (transition == 2) {
    if (target_present != existed || swap_present) {
      fail_closed("configuration apply state is not pristine");
    }
    struct stat staged;
    if (existed) {
      int target_fd = -1;
      target_entry = open_regular_at(directory, target, &target_fd);
      require_metadata(&target_entry, owner, group, mode);
      if (!files_equal(target_fd, 3)) fail_closed("original configuration drifted");
      require_same_entry(directory, target, &target_entry);
      copy_descriptor_to_new_file(4, directory, temporary, owner, group, mode, &staged);
      require_same_entry(directory, temporary, &staged);
      if (renameat2_exact(directory, target, directory, temporary, RENAME_EXCHANGE) != 0 ||
          renameat2_exact(directory, temporary, directory, swap, RENAME_NOREPLACE) != 0) {
        fail_closed("configuration apply exchange failed");
      }
      (void)close(target_fd);
    } else {
      copy_descriptor_to_new_file(4, directory, temporary, 0, 0, 0644, &staged);
      require_same_entry(directory, temporary, &staged);
      if (renameat2_exact(directory, temporary, directory, target, RENAME_NOREPLACE) != 0) {
        fail_closed("configuration apply create failed");
      }
    }
  } else if (transition == 0) {
    int target_fd = -1;
    target_entry = open_regular_at(directory, target, &target_fd);
    require_metadata(&target_entry, existed ? owner : 0, existed ? group : 0,
                     existed ? mode : 0644);
    if (!files_equal(target_fd, 4)) fail_closed("managed configuration drifted");
    require_same_entry(directory, target, &target_entry);
    if (existed) {
      if (swap_present) {
        int swap_fd = -1;
        swap_entry = open_regular_at(directory, swap, &swap_fd);
        if (!files_equal(swap_fd, 3)) fail_closed("original configuration swap drifted");
        require_metadata(&swap_entry, owner, group, mode);
        require_same_entry(directory, swap, &swap_entry);
        if (renameat2_exact(directory, target, directory, swap, RENAME_EXCHANGE) != 0) {
          fail_closed("configuration exchange failed");
        }
        (void)close(swap_fd);
      } else {
        struct stat staged;
        copy_descriptor_to_new_file(3, directory, temporary, owner, group, mode, &staged);
        require_same_entry(directory, target, &target_entry);
        require_same_entry(directory, temporary, &staged);
        if (renameat2_exact(directory, target, directory, temporary, RENAME_EXCHANGE) != 0 ||
            renameat2_exact(directory, temporary, directory, swap, RENAME_NOREPLACE) != 0) {
          fail_closed("configuration first exchange failed");
        }
      }
    } else if (renameat2_exact(directory, target, directory, swap, RENAME_NOREPLACE) != 0) {
      fail_closed("configuration removal failed");
    }
    (void)close(target_fd);
  } else if (transition == 1 && existed) {
    if (!target_present || !swap_present) fail_closed("configuration restore state is partial");
    int target_fd = -1;
    int swap_fd = -1;
    target_entry = open_regular_at(directory, target, &target_fd);
    swap_entry = open_regular_at(directory, swap, &swap_fd);
    if (!files_equal(target_fd, 3) || !files_equal(swap_fd, 4)) {
      fail_closed("configuration restore content drifted");
    }
    require_metadata(&target_entry, owner, group, mode);
    require_same_entry(directory, target, &target_entry);
    require_same_entry(directory, swap, &swap_entry);
    if (renameat2_exact(directory, target, directory, swap, RENAME_EXCHANGE) != 0) {
      fail_closed("configuration restore exchange failed");
    }
    (void)close(target_fd);
    (void)close(swap_fd);
  } else if (transition == 1) {
    if (target_present || !swap_present) fail_closed("configuration restore state is partial");
    int swap_fd = -1;
    swap_entry = open_regular_at(directory, swap, &swap_fd);
    if (!files_equal(swap_fd, 4)) fail_closed("managed configuration swap drifted");
    require_same_entry(directory, swap, &swap_entry);
    if (renameat2_exact(directory, swap, directory, target, RENAME_NOREPLACE) != 0) {
      fail_closed("configuration restore failed");
    }
    (void)close(swap_fd);
  }
  if (transition == 2 && existed) {
    require_file_matches(directory, target, 4, owner, group, mode);
    require_file_matches(directory, swap, 3, owner, group, mode);
  } else if (transition == 2) {
    require_file_matches(directory, target, 4, 0, 0, 0644);
    require_missing_entry(directory, swap);
  } else if (transition == 0 && existed) {
    require_file_matches(directory, target, 3, owner, group, mode);
    require_file_matches(directory, swap, 4, owner, group, mode);
  } else if (transition == 0) {
    require_missing_entry(directory, target);
    require_file_matches(directory, swap, 4, 0, 0, 0644);
  } else if (transition == 1 && existed) {
    require_file_matches(directory, target, 4, owner, group, mode);
    require_file_matches(directory, swap, 3, owner, group, mode);
  } else {
    require_file_matches(directory, target, 4, 0, 0, 0644);
    require_missing_entry(directory, swap);
  }
  sync_directory(directory);
  if (close(directory) != 0) fail_closed("configuration directory close failed");
  const char *operation = transition == 2 ? "apply" : transition == 1 ? "restore" : "rollback";
  (void)printf("{\"operation\":\"%s-config\",\"config\":\"%s\"}\n",
               operation, argv[2]);
  return 0;
}
#endif

int main(int argc, char **argv) {
#if defined(__linux__) && defined(SYS_renameat2)
  (void)umask(0077);
  if (geteuid() != 0 || argc < 2) fail_closed("root and exact operation are required");
  require_initial_mount_namespace();
  if (strcmp(argv[1], "verify-namespace") == 0 && argc == 2) {
    (void)printf("{\"operation\":\"verify-namespace\",\"verified\":true}\n");
    return 0;
  }
  if (strcmp(argv[1], "publish-record") == 0 && argc == 3) return publish_record(argv[2]);
  if (strcmp(argv[1], "create-source") == 0 && argc == 2) return create_source();
  if (strcmp(argv[1], "backup-header") == 0 && argc == 2) return backup_header();
  if (strcmp(argv[1], "rollback-source") == 0 && argc == 2) return move_source(0);
  if (strcmp(argv[1], "restore-source") == 0 && argc == 2) return move_source(1);
  if (strcmp(argv[1], "apply-config") == 0) return config_transition(argc, argv, 2);
  if (strcmp(argv[1], "rollback-config") == 0) return config_transition(argc, argv, 0);
  if (strcmp(argv[1], "restore-config") == 0) return config_transition(argc, argv, 1);
  fail_closed("operation is not allowlisted");
#else
  (void)argc;
  (void)argv;
  fail_closed("Linux renameat2 boundary is unavailable");
#endif
  return 126;
}
