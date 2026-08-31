#define _DARWIN_C_SOURCE
#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#if defined(__linux__)
#include <sys/prctl.h>
#endif

#if defined(SEORILABS_P2_TEST_ROOT)
#define ASK_DIRECTORY SEORILABS_P2_TEST_ROOT "/run/systemd/ask-password"
#define SOURCE_PATH SEORILABS_P2_TEST_ROOT "/data/seori-auth/seori-auth-state.luks"
#else
#define ASK_DIRECTORY "/run/systemd/ask-password"
#define SOURCE_PATH "/data/seori-auth/seori-auth-state.luks"
#endif

#if defined(SEORILABS_P2_CLEVIS_EXECUTABLE)
#define CLEVIS_EXECUTABLE SEORILABS_P2_CLEVIS_EXECUTABLE
#else
#define CLEVIS_EXECUTABLE "/usr/bin/clevis"
#endif

#if defined(SEORILABS_P2_REPLY_EXECUTABLE)
#define REPLY_EXECUTABLE SEORILABS_P2_REPLY_EXECUTABLE
#else
#define REPLY_EXECUTABLE "/lib/systemd/systemd-reply-password"
#endif

#define SOURCE_SIZE_BYTES ((off_t)17179869184LL)
#define ASK_FILE_MAX_BYTES ((size_t)8192)
#define CLEVIS_SLOT "1"

struct selected_question {
  char name[NAME_MAX + 1];
  char socket_path[PATH_MAX];
  dev_t device;
  ino_t inode;
  off_t size;
};

static void fail_closed(const char *code) {
  (void)dprintf(STDERR_FILENO, "seorilabs-p2-regular-file-askpass: %s\n", code);
  _exit(126);
}

static uid_t trusted_owner(void) {
#if defined(SEORILABS_P2_TEST_ROOT)
  return geteuid();
#else
  return 0;
#endif
}

static void harden_process(void) {
  struct rlimit core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &core) != 0) fail_closed("PROCESS_HARDENING_FAILED");
#if defined(__linux__)
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fail_closed("PROCESS_HARDENING_FAILED");
  }
#endif
}

static void require_root(void) {
#if !defined(SEORILABS_P2_TEST_ROOT)
  if (geteuid() != 0) fail_closed("ROOT_REQUIRED");
#endif
}

static int open_trusted_directory(void) {
  int descriptor = open(ASK_DIRECTORY, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat entry;
  if (descriptor < 0 || fstat(descriptor, &entry) != 0 || !S_ISDIR(entry.st_mode) ||
      entry.st_uid != trusted_owner() || (entry.st_mode & 0022) != 0) {
    if (descriptor >= 0) (void)close(descriptor);
    fail_closed("ASK_DIRECTORY_INVALID");
  }
  return descriptor;
}

static int safe_question_name(const char *name) {
  if (strncmp(name, "ask.", 4) != 0 || name[4] == '\0') return 0;
  for (const unsigned char *cursor = (const unsigned char *)name + 4; *cursor != '\0'; cursor++) {
    if (!(('a' <= *cursor && *cursor <= 'z') || ('A' <= *cursor && *cursor <= 'Z') ||
          ('0' <= *cursor && *cursor <= '9') || *cursor == '.' || *cursor == '_' ||
          *cursor == '-')) return 0;
  }
  return 1;
}

static int safe_socket_path(const char *path, const char **leaf) {
  const size_t prefix_length = strlen(ASK_DIRECTORY) + 1;
  if (strncmp(path, ASK_DIRECTORY "/", prefix_length) != 0) return 0;
  const char *candidate = path + prefix_length;
  if (strncmp(candidate, "sck.", 4) != 0 || candidate[4] == '\0' || strchr(candidate, '/') != NULL) {
    return 0;
  }
  for (const unsigned char *cursor = (const unsigned char *)candidate + 4;
       *cursor != '\0'; cursor++) {
    if (!(('a' <= *cursor && *cursor <= 'z') || ('A' <= *cursor && *cursor <= 'Z') ||
          ('0' <= *cursor && *cursor <= '9') || *cursor == '.' || *cursor == '_' ||
          *cursor == '-')) return 0;
  }
  *leaf = candidate;
  return 1;
}

static size_t read_question(int descriptor, char *buffer, size_t capacity) {
  size_t total = 0;
  while (total < capacity - 1) {
    ssize_t count = read(descriptor, buffer + total, capacity - 1 - total);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) fail_closed("ASK_FILE_READ_FAILED");
    if (count == 0) break;
    total += (size_t)count;
  }
  unsigned char overflow;
  ssize_t extra;
  do {
    extra = read(descriptor, &overflow, 1);
  } while (extra < 0 && errno == EINTR);
  if (extra != 0 || total == 0) fail_closed("ASK_FILE_INVALID");
  buffer[total] = '\0';
  return total;
}

static int parse_question(char *buffer, char *socket_path, size_t socket_capacity) {
  const char expected_id[] = "Id=cryptsetup:" SOURCE_PATH;
  int id_count = 0;
  int exact_id = 0;
  int socket_count = 0;
  char *save = NULL;
  for (char *line = strtok_r(buffer, "\n", &save); line != NULL;
       line = strtok_r(NULL, "\n", &save)) {
    const size_t length = strlen(line);
    if (length > 0 && line[length - 1] == '\r') line[length - 1] = '\0';
    if (strncmp(line, "Id=", 3) == 0) {
      id_count++;
      if (strcmp(line, expected_id) == 0) exact_id = 1;
    } else if (strncmp(line, "Socket=", 7) == 0) {
      const char *value = line + 7;
      socket_count++;
      if (strlen(value) >= socket_capacity) fail_closed("ASK_SOCKET_INVALID");
      (void)strcpy(socket_path, value);
    }
  }
  if (!exact_id) return 0;
  if (id_count != 1 || socket_count != 1) fail_closed("ASK_FILE_INVALID");
  return 1;
}

static void require_socket(int directory, const char *socket_path) {
  const char *leaf = NULL;
  struct stat entry;
  if (!safe_socket_path(socket_path, &leaf) ||
      fstatat(directory, leaf, &entry, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISSOCK(entry.st_mode) || entry.st_uid != trusted_owner()) {
    fail_closed("ASK_SOCKET_INVALID");
  }
}

static int open_source(void) {
  int descriptor = open(SOURCE_PATH, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat entry;
  if (descriptor < 0 || fstat(descriptor, &entry) != 0 || !S_ISREG(entry.st_mode) ||
      entry.st_uid != trusted_owner() || (entry.st_mode & 07777) != 0600 ||
#if defined(SEORILABS_P2_TEST_ROOT)
      entry.st_size <= 0
#else
      entry.st_size != SOURCE_SIZE_BYTES || entry.st_blocks * 512 < SOURCE_SIZE_BYTES
#endif
  ) {
    if (descriptor >= 0) (void)close(descriptor);
    fail_closed("SOURCE_IDENTITY_INVALID");
  }
  return descriptor;
}

static int wait_success(pid_t child) {
  int status = 0;
  pid_t observed;
  do {
    observed = waitpid(child, &status, 0);
  } while (observed < 0 && errno == EINTR);
  return observed == child && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static void close_descriptors_except(int keep) {
  long maximum = sysconf(_SC_OPEN_MAX);
  if (maximum < 0 || maximum > 65536) maximum = 65536;
  for (int descriptor = 3; descriptor < maximum; descriptor++) {
    if (descriptor != keep) (void)close(descriptor);
  }
}

static void redirect_to_null(int target, int flags) {
  int descriptor = open("/dev/null", flags | O_CLOEXEC);
  if (descriptor < 0 || dup2(descriptor, target) < 0) _exit(126);
  if (descriptor != target) (void)close(descriptor);
}

static pid_t spawn_reply(int pipe_read, const char *socket_path) {
  pid_t child = fork();
  if (child < 0) fail_closed("REPLY_FORK_FAILED");
  if (child == 0) {
    if (dup2(pipe_read, STDIN_FILENO) < 0) _exit(126);
    redirect_to_null(STDOUT_FILENO, O_WRONLY);
    redirect_to_null(STDERR_FILENO, O_WRONLY);
    close_descriptors_except(-1);
    char *const arguments[] = {
      (char *)REPLY_EXECUTABLE, (char *)"1", (char *)socket_path, NULL,
    };
    char *const environment[] = {
      (char *)"PATH=/usr/sbin:/usr/bin:/sbin:/bin",
      (char *)"LANG=C", (char *)"LC_ALL=C", NULL,
    };
    execve(REPLY_EXECUTABLE, arguments, environment);
    _exit(126);
  }
  return child;
}

static pid_t spawn_clevis(int pipe_write, int source) {
  pid_t child = fork();
  if (child < 0) fail_closed("CLEVIS_FORK_FAILED");
  if (child == 0) {
    redirect_to_null(STDIN_FILENO, O_RDONLY);
    if (dup2(pipe_write, STDOUT_FILENO) < 0 || dup2(source, 3) < 0 ||
        fcntl(3, F_SETFD, 0) != 0) _exit(126);
    redirect_to_null(STDERR_FILENO, O_WRONLY);
    close_descriptors_except(3);
    char *const arguments[] = {
      (char *)CLEVIS_EXECUTABLE, (char *)"luks", (char *)"pass",
      (char *)"-d", (char *)"/proc/self/fd/3", (char *)"-s", (char *)CLEVIS_SLOT, NULL,
    };
    char *const environment[] = {
      (char *)"PATH=/usr/sbin:/usr/bin:/sbin:/bin",
      (char *)"LANG=C", (char *)"LC_ALL=C", NULL,
    };
    execve(CLEVIS_EXECUTABLE, arguments, environment);
    _exit(126);
  }
  return child;
}

static void direct_pipe_secret(int source, const char *socket_path) {
  int descriptors[2];
  if (pipe(descriptors) != 0 || fcntl(descriptors[0], F_SETFD, FD_CLOEXEC) != 0 ||
      fcntl(descriptors[1], F_SETFD, FD_CLOEXEC) != 0) {
    fail_closed("SECRET_PIPE_FAILED");
  }
  const pid_t reply = spawn_reply(descriptors[0], socket_path);
  const pid_t clevis = spawn_clevis(descriptors[1], source);
  if (close(descriptors[0]) != 0 || close(descriptors[1]) != 0) {
    (void)kill(clevis, SIGKILL);
    (void)kill(reply, SIGKILL);
    fail_closed("SECRET_PIPE_FAILED");
  }
  const int clevis_ok = wait_success(clevis);
  const int reply_ok = wait_success(reply);
  if (!clevis_ok || !reply_ok) fail_closed("UNLOCK_REPLY_FAILED");
}

static int find_exact_question(int directory, struct selected_question *selected) {
  int duplicate = dup(directory);
  if (duplicate < 0) fail_closed("ASK_DIRECTORY_READ_FAILED");
  DIR *stream = fdopendir(duplicate);
  if (stream == NULL) {
    (void)close(duplicate);
    fail_closed("ASK_DIRECTORY_READ_FAILED");
  }
  int matches = 0;
  while (1) {
    errno = 0;
    struct dirent *item = readdir(stream);
    if (item == NULL) {
      if (errno != 0) {
        closedir(stream);
        fail_closed("ASK_DIRECTORY_READ_FAILED");
      }
      break;
    }
    if (!safe_question_name(item->d_name)) continue;
    int descriptor = openat(directory, item->d_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat entry;
    char buffer[ASK_FILE_MAX_BYTES];
    char socket_path[PATH_MAX] = {0};
    if (descriptor < 0 || fstat(descriptor, &entry) != 0 || !S_ISREG(entry.st_mode) ||
        entry.st_uid != trusted_owner() || (entry.st_mode & 0022) != 0) {
      if (descriptor >= 0) (void)close(descriptor);
      closedir(stream);
      fail_closed("ASK_FILE_INVALID");
    }
    const size_t bytes = read_question(descriptor, buffer, sizeof(buffer));
    if (entry.st_size != (off_t)bytes) {
      (void)close(descriptor);
      closedir(stream);
      fail_closed("ASK_FILE_CHANGED");
    }
    if (parse_question(buffer, socket_path, sizeof(socket_path))) {
      matches++;
      if (matches > 1) {
        (void)close(descriptor);
        closedir(stream);
        fail_closed("DUPLICATE_ASK_REFUSED");
      }
      require_socket(directory, socket_path);
      (void)strcpy(selected->name, item->d_name);
      (void)strcpy(selected->socket_path, socket_path);
      selected->device = entry.st_dev;
      selected->inode = entry.st_ino;
      selected->size = entry.st_size;
    }
    (void)memset(buffer, 0, sizeof(buffer));
    if (close(descriptor) != 0) {
      closedir(stream);
      fail_closed("ASK_FILE_CLOSE_FAILED");
    }
  }
  if (closedir(stream) != 0) fail_closed("ASK_DIRECTORY_READ_FAILED");
  return matches;
}

static void revalidate_question(int directory, const struct selected_question *selected) {
  int descriptor = openat(directory, selected->name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat entry;
  char buffer[ASK_FILE_MAX_BYTES];
  char socket_path[PATH_MAX] = {0};
  if (descriptor < 0 || fstat(descriptor, &entry) != 0 ||
      entry.st_dev != selected->device || entry.st_ino != selected->inode ||
      entry.st_size != selected->size) {
    if (descriptor >= 0) (void)close(descriptor);
    fail_closed("ASK_FILE_CHANGED");
  }
  (void)read_question(descriptor, buffer, sizeof(buffer));
  if (!parse_question(buffer, socket_path, sizeof(socket_path)) ||
      strcmp(socket_path, selected->socket_path) != 0) {
    (void)close(descriptor);
    fail_closed("ASK_FILE_CHANGED");
  }
  require_socket(directory, socket_path);
  (void)memset(buffer, 0, sizeof(buffer));
  if (close(descriptor) != 0) fail_closed("ASK_FILE_CLOSE_FAILED");
}

int main(int argc, char **argv) {
  (void)argv;
  (void)umask(0077);
  if (argc != 1) fail_closed("ARGUMENTS_REFUSED");
  require_root();
  harden_process();
  int directory = open_trusted_directory();
  struct selected_question selected = {{0}, {0}, 0, 0, 0};
  if (find_exact_question(directory, &selected) == 0) {
    if (close(directory) != 0) fail_closed("ASK_DIRECTORY_CLOSE_FAILED");
    return 0;
  }
  revalidate_question(directory, &selected);
  int source = open_source();
  direct_pipe_secret(source, selected.socket_path);
  if (close(source) != 0 || close(directory) != 0) fail_closed("BOUNDARY_CLOSE_FAILED");
  (void)memset(&selected, 0, sizeof(selected));
  return 0;
}
