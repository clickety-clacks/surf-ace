#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

/* Source-only, unrun private reliability fixture. No packaged-app execution
 * until this hook, its sidecar, and the vehicle receive exact-byte review. */
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static char pending_sha[65];
static int pending_seen;
static int candidate_kind; /* 0 absent, 1 binding-free, 2 binding-bearing */
static int stopped;

static const char *env_required(const char *name) {
  const char *value = getenv(name);
  return value && *value ? value : NULL;
}

static void trace_event(const char *event, const char *sha) {
  const char *file = env_required("SURF_ACE_BINDING_TRACE");
  if (!file) return;
  int fd = open(file, O_WRONLY | O_APPEND | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return;
  char line[160];
  int n = snprintf(line, sizeof(line), "pid=%ld event=%s sha=%s\n", (long)getpid(), event,
                   sha ? sha : "none");
  if (n > 0 && n < (int)sizeof(line)) (void)write(fd, line, (size_t)n);
  close(fd);
}

static int expected_browser(void) {
  const char *file = env_required("SURF_ACE_BINDING_BROWSER_PID_FILE");
  if (!file) return 0;
  int fd = open(file, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return 0;
  char text[32] = {0};
  ssize_t n = read(fd, text, sizeof(text) - 1);
  close(fd);
  if (n < 2 || text[n - 1] != '\n') return 0;
  char *end;
  long pid = strtol(text, &end, 10);
  return end == text + n - 1 && pid > 1 && pid == (long)getpid();
}

static int root_target(const char *destination) {
  const char *root = env_required("SURF_ACE_BINDING_USER_DATA");
  if (!root || !destination || destination[0] != '/') return 0;
  size_t length = strlen(root);
  if (length < 50 || strncmp(destination, root, length) || destination[length] != '/') return 0;
  const char *name = destination + length + 1;
  return strcmp(name, "surface-core-state.json") == 0 ||
         strcmp(name, "surface-core-state.json.selector") == 0;
}

static int extract_hash(const char *file, const char *key, char out[65]) {
  int fd = open(file, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return 0;
  char text[4097] = {0};
  ssize_t n = read(fd, text, sizeof(text));
  close(fd);
  if (n <= 0 || n >= (ssize_t)sizeof(text)) return 0;
  char quoted[80];
  int q = snprintf(quoted, sizeof(quoted), "\"%s\"", key);
  if (q <= 0 || q >= (int)sizeof(quoted)) return 0;
  char *at = strstr(text, quoted);
  if (!at) return 0;
  at += q;
  while (*at == ' ' || *at == '\t' || *at == '\n') at++;
  if (*at++ != ':') return 0;
  while (*at == ' ' || *at == '\t' || *at == '\n') at++;
  if (*at++ != '"') return 0;
  for (int i = 0; i < 64; i++) {
    char c = at[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
    out[i] = c;
  }
  if (at[64] != '"') return 0;
  out[64] = 0;
  return 1;
}

static int selector_phase(const char *file) {
  int fd = open(file, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return 0;
  char text[4097] = {0};
  ssize_t n = read(fd, text, sizeof(text));
  close(fd);
  if (n <= 0 || n >= (ssize_t)sizeof(text)) return 0;
  if (strstr(text, "\"phase\": \"pending\"") ||
      strstr(text, "\"phase\":\"pending\"")) return 1;
  if (strstr(text, "\"phase\": \"committed\"") ||
      strstr(text, "\"phase\":\"committed\"")) return 2;
  return 0;
}

static int private_path(const char *file) {
  const char *root = env_required("SURF_ACE_BINDING_USER_DATA");
  if (!root || !file) return 0;
  size_t n = strlen(root);
  if (strncmp(file, root, n) || file[n] != '/') return 0;
  for (const char *c = file; *c; c++) {
    if (!( (*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') ||
           (*c >= '0' && *c <= '9') || *c == '/' || *c == '-' ||
           *c == '_' || *c == '.')) return 0;
  }
  return strlen(file) < 350;
}

static int classify(const char *candidate, const char *sha) {
  const char *socket_path = env_required("SURF_ACE_BINDING_SOCKET");
  if (!socket_path || strlen(socket_path) >= sizeof(((struct sockaddr_un *)0)->sun_path) ||
      !private_path(candidate)) return -1;
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return -1;
  struct timeval timeout = {.tv_sec = 2, .tv_usec = 0};
  (void)setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  strcpy(address.sun_path, socket_path);
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { close(fd); return -1; }
  char request[512];
  int n = snprintf(request, sizeof(request),
      "{\"event\":\"candidate\",\"path\":\"%s\",\"pendingSha256\":\"%s\"}\n",
      candidate, sha);
  if (n <= 0 || n >= (int)sizeof(request) || send(fd, request, (size_t)n, MSG_NOSIGNAL) != n) {
    close(fd); return -1;
  }
  char response[256] = {0};
  size_t used = 0;
  while (used < sizeof(response) - 1) {
    ssize_t count = recv(fd, response + used, sizeof(response) - 1 - used, 0);
    if (count <= 0) break;
    used += (size_t)count;
    if (memchr(response, '\n', used)) break;
  }
  close(fd);
  if (!used || used >= sizeof(response) - 1 || !strchr(response, '\n')) return -1;
  if (!strstr(response, "\"ok\":true") || !strstr(response, sha)) return -1;
  if (strstr(response, "\"bindingBearing\":true")) return 2;
  if (strstr(response, "\"bindingBearing\":false")) return 1;
  return -1;
}

static void stop_now(const char *phase, const char *destination) {
  if (!expected_browser()) _exit(91);
  const char *file = env_required("SURF_ACE_BINDING_MARKER");
  const char *root = env_required("SURF_ACE_BINDING_USER_DATA");
  if (!file || !root) _exit(92);
  int dir = open(root, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (dir < 0 || fsync(dir) != 0) _exit(93);
  close(dir);
  int fd = open(file, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) _exit(94);
  char text[600];
  int n = snprintf(text, sizeof(text), "phase=%s\npid=%ld\ncandidateSha256=%s\ndestination=%s\n",
                   phase, (long)getpid(), pending_sha, destination);
  if (n <= 0 || n >= (int)sizeof(text) || write(fd, text, (size_t)n) != n || fsync(fd)) _exit(95);
  close(fd);
  trace_event("stop", pending_sha);
  stopped = 1;
  kill(getpid(), SIGKILL);
  _exit(96);
}

typedef int (*rename_fn)(const char *, const char *);
static int handle_rename(const char *source, const char *destination, rename_fn real_call) {
  if (!root_target(destination) || !expected_browser()) return real_call(source, destination);
  pthread_mutex_lock(&lock);
  const char *name = strrchr(destination, '/');
  int selector = name && strcmp(name + 1, "surface-core-state.json.selector") == 0;
  int phase = selector ? selector_phase(source) : 0;
  const char *wanted = env_required("SURF_ACE_BINDING_PHASE");
  if (!wanted || (strcmp(wanted, "before_candidate_primary_rename") &&
                  strcmp(wanted, "after_committed_selector_rename"))) {
    trace_event("phase_invalid", NULL); errno = EINVAL; pthread_mutex_unlock(&lock); return -1;
  }
  int result = -1;
  if (selector && phase == 1) {
    char hash[65] = {0};
    if (pending_seen || !extract_hash(source, "candidateSha256", hash)) goto invalid;
    result = real_call(source, destination);
    if (!result) {
      memcpy(pending_sha, hash, sizeof(pending_sha));
      pending_seen = 1;
      candidate_kind = 0;
      trace_event("pending", pending_sha);
    }
  } else if (!selector) {
    if (!pending_seen || candidate_kind) goto invalid;
    candidate_kind = classify(source, pending_sha);
    if (candidate_kind < 1) goto invalid;
    trace_event(candidate_kind == 2 ? "binding_candidate" : "binding_free", pending_sha);
    if (candidate_kind == 2 && strcmp(wanted, "before_candidate_primary_rename") == 0)
      stop_now(wanted, destination);
    result = real_call(source, destination);
  } else if (phase == 2) {
    char hash[65] = {0};
    if (!pending_seen || !candidate_kind ||
        !extract_hash(source, "acceptedSha256", hash) || strcmp(hash, pending_sha)) goto invalid;
    result = real_call(source, destination);
    if (!result) {
      trace_event("committed", pending_sha);
      if (candidate_kind == 2 && strcmp(wanted, "after_committed_selector_rename") == 0)
        stop_now(wanted, destination);
      pending_seen = 0;
      candidate_kind = 0;
      pending_sha[0] = 0;
    }
  } else goto invalid;
  pthread_mutex_unlock(&lock);
  return result;
invalid:
  trace_event("ordering_or_verifier_invalid", pending_sha[0] ? pending_sha : NULL);
  errno = EPROTO;
  pthread_mutex_unlock(&lock);
  return -1;
}

static int resolve_path(int dirfd, const char *name, char result[PATH_MAX]) {
  if (!name) return 0;
  if (name[0] == '/') {
    if (strlen(name) >= PATH_MAX) return 0;
    strcpy(result, name); return 1;
  }
  char base[PATH_MAX];
  if (dirfd == AT_FDCWD) {
    if (!getcwd(base, sizeof(base))) return 0;
  } else {
    char link[64];
    snprintf(link, sizeof(link), "/proc/self/fd/%d", dirfd);
    ssize_t n = readlink(link, base, sizeof(base) - 1);
    if (n <= 0 || n >= (ssize_t)sizeof(base)) return 0;
    base[n] = 0;
  }
  int n = snprintf(result, PATH_MAX, "%s/%s", base, name);
  return n > 0 && n < PATH_MAX;
}

int rename(const char *source, const char *destination) {
  rename_fn real_call = (rename_fn)dlsym(RTLD_NEXT, "rename");
  if (!real_call) { errno = ENOSYS; return -1; }
  return handle_rename(source, destination, real_call);
}

typedef int (*renameat_fn)(int, const char *, int, const char *);
static renameat_fn real_renameat;
static int renameat_call(const char *source, const char *destination) {
  return real_renameat(AT_FDCWD, source, AT_FDCWD, destination);
}
int renameat(int source_dir, const char *source, int destination_dir, const char *destination) {
  real_renameat = (renameat_fn)dlsym(RTLD_NEXT, "renameat");
  if (!real_renameat) { errno = ENOSYS; return -1; }
  char src[PATH_MAX], dst[PATH_MAX];
  if (!resolve_path(source_dir, source, src) || !resolve_path(destination_dir, destination, dst)) {
    errno = EINVAL; return -1;
  }
  return handle_rename(src, dst, renameat_call);
}

typedef int (*renameat2_fn)(int, const char *, int, const char *, unsigned int);
static renameat2_fn real_renameat2;
static int renameat2_call(const char *source, const char *destination) {
  return real_renameat2(AT_FDCWD, source, AT_FDCWD, destination, 0);
}
int renameat2(int source_dir, const char *source, int destination_dir, const char *destination,
              unsigned int flags) {
  real_renameat2 = (renameat2_fn)dlsym(RTLD_NEXT, "renameat2");
  if (!real_renameat2) { errno = ENOSYS; return -1; }
  char src[PATH_MAX], dst[PATH_MAX];
  if (!resolve_path(source_dir, source, src) || !resolve_path(destination_dir, destination, dst)) {
    errno = EINVAL; return -1;
  }
  if (flags && root_target(dst)) { errno = EINVAL; return -1; }
  if (flags) return real_renameat2(source_dir, source, destination_dir, destination, flags);
  return handle_rename(src, dst, renameat2_call);
}
