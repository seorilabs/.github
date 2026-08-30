#if defined(__linux__)
#define _GNU_SOURCE
#endif

#include <node_api.h>

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>

#if defined(__linux__)
#include <sys/prctl.h>
#elif defined(__APPLE__)
#include <sys/ptrace.h>
#else
#error "P2 process hardening boundary supports only Linux and macOS"
#endif

#define NATIVE_LAUNCH_MARKER "SEORI_AUTH_NATIVE_LAUNCHED"

static napi_value fail_closed(napi_env env) {
  (void)napi_throw_error(env, NULL, "P2_PROCESS_HARDENING_BOUNDARY_FAILED");
  return NULL;
}

static int set_string(napi_env env, napi_value object, const char *key, const char *value) {
  napi_value encoded;
  return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &encoded) == napi_ok &&
      napi_set_named_property(env, object, key, encoded) == napi_ok;
}

static int set_uint32(napi_env env, napi_value object, const char *key, uint32_t value) {
  napi_value encoded;
  return napi_create_uint32(env, value, &encoded) == napi_ok &&
      napi_set_named_property(env, object, key, encoded) == napi_ok;
}

#if defined(__APPLE__)
static int set_boolean(napi_env env, napi_value object, const char *key, int value) {
  napi_value encoded;
  return napi_get_boolean(env, value, &encoded) == napi_ok &&
      napi_set_named_property(env, object, key, encoded) == napi_ok;
}
#endif

NAPI_MODULE_INIT() {
  (void)exports;
  struct rlimit core_limit;
  const char *marker = getenv(NATIVE_LAUNCH_MARKER);
  if (
      marker == NULL || strcmp(marker, "1") != 0 ||
      getrlimit(RLIMIT_CORE, &core_limit) != 0 ||
      core_limit.rlim_cur != 0 || core_limit.rlim_max != 0) {
    return fail_closed(env);
  }

#if defined(__linux__)
  if (
      prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1 ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
      prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0) {
    return fail_closed(env);
  }
#elif defined(__APPLE__)
  /*
   * Darwin exposes no public getter for P_LNOATTACH. A successful
   * PT_DENY_ATTACH call is the kernel acknowledgement that the flag was set;
   * failure aborts module initialization before JavaScript can read secrets.
   */
  if (ptrace(PT_DENY_ATTACH, 0, NULL, 0) != 0) {
    return fail_closed(env);
  }
#endif

  napi_value receipt;
  if (
      napi_create_object(env, &receipt) != napi_ok ||
      !set_string(env, receipt, "state", "PROCESS_HARDENING_OK") ||
      !set_uint32(env, receipt, "coreSoft", 0) ||
      !set_uint32(env, receipt, "coreHard", 0)) {
    return fail_closed(env);
  }
#if defined(__linux__)
  if (
      !set_uint32(env, receipt, "dumpable", 0) ||
      !set_uint32(env, receipt, "noNewPrivileges", 1)) {
    return fail_closed(env);
  }
#elif defined(__APPLE__)
  if (!set_boolean(env, receipt, "denyAttachApplied", 1)) {
    return fail_closed(env);
  }
#endif
  return receipt;
}
