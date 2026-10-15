#import <AppKit/AppKit.h>
#import <objc/message.h>
#include <cmath>
#include <climits>
#include <node_api.h>

static napi_value PreventActivation(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  double windowNumber = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_double(env, args[0], &windowNumber) != napi_ok ||
      !std::isfinite(windowNumber) || windowNumber <= 0 || windowNumber > INT_MAX ||
      std::floor(windowNumber) != windowNumber) {
    napi_throw_type_error(env, nullptr, "Expected one positive native window number");
    return nullptr;
  }
  if (![NSThread isMainThread]) {
    napi_throw_error(env, nullptr, "Panel setup requires the main thread");
    return nullptr;
  }

  // Resolve only a window owned by this process; never dereference a JS-provided pointer.
  NSWindow *window = [NSApp windowWithWindowNumber:static_cast<NSInteger>(windowNumber)];
  SEL prevent = NSSelectorFromString(@"_setPreventsActivation:");
  BOOL applied = NO;
  if (window && (window.styleMask & NSWindowStyleMaskNonactivatingPanel) &&
      [window respondsToSelector:prevent]) {
    // Electron's panel styleMask alone no longer sets this WindowServer tag on macOS 27.
    // https://github.com/electron/electron/issues/53889
    reinterpret_cast<void (*)(id, SEL, BOOL)>(objc_msgSend)(window, prevent, YES);
    applied = YES;
  }
  napi_value result;
  napi_get_boolean(env, applied, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "preventActivation", NAPI_AUTO_LENGTH, PreventActivation, nullptr, &fn);
  napi_set_named_property(env, exports, "preventActivation", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
