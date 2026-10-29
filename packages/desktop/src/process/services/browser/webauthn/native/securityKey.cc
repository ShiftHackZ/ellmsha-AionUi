#include <node_api.h>
#include <fido.h>
#include <fido/err.h>
#include <openssl/crypto.h>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>
#include "credentialPolicy.h"

// Synchronous native IO runs only in a disposable utility process. Requiring
// this module performs no device discovery or other hardware interaction.
namespace {
void check(napi_status value) { if (value != napi_ok) throw std::runtime_error("Invalid native argument"); }
void require(bool value) { if (!value) throw std::runtime_error("Invalid native argument"); }
napi_value object(napi_env e) { napi_value v; check(napi_create_object(e, &v)); return v; }
napi_value text(napi_env e, const std::string& s) { require(s.size() <= 4096); napi_value v; check(napi_create_string_utf8(e, s.data(), s.size(), &v)); return v; }
void set(napi_env e, napi_value o, const char* key, napi_value v) { check(napi_set_named_property(e, o, key, v)); }
napi_value get(napi_env e, napi_value o, const char* key) { napi_value v; check(napi_get_named_property(e, o, key, &v)); return v; }
void number(napi_env e, napi_value o, const char* key, int n) { napi_value v; check(napi_create_int32(e, n, &v)); set(e, o, key, v); }
void boolean(napi_env e, napi_value o, const char* key, bool b) { napi_value v; check(napi_get_boolean(e, b, &v)); set(e, o, key, v); }
std::string string(napi_env e, napi_value v, size_t max = 4096) {
  size_t n = 0; check(napi_get_value_string_utf8(e, v, nullptr, 0, &n)); require(n <= max);
  std::vector<char> data(n + 1); check(napi_get_value_string_utf8(e, v, data.data(), data.size(), &n));
  require(std::memchr(data.data(), 0, n) == nullptr); return std::string(data.data(), n);
}
std::vector<unsigned char> bytes(napi_env e, napi_value v, size_t max) {
  bool isBuffer = false; check(napi_is_buffer(e, v, &isBuffer)); require(isBuffer);
  void* data = nullptr; size_t size = 0; check(napi_get_buffer_info(e, v, &data, &size)); require(size > 0 && size <= max);
  const auto* start = static_cast<const unsigned char*>(data); return {start, start + size};
}
napi_value buffer(napi_env e, const unsigned char* data, size_t n) {
  require(n <= 65536); napi_value v; check(napi_create_buffer_copy(e, n, data, nullptr, &v)); return v;
}
napi_value result(napi_env e, int code) { auto v = object(e); number(e, v, "code", code); return v; }
struct Device {
  fido_dev_t* value = fido_dev_new(); bool opened = false;
  explicit Device(const std::string& path) { require(value != nullptr); fido_dev_set_timeout(value, 5000); opened = fido_dev_open(value, path.c_str()) == FIDO_OK; }
  ~Device() { if (value) { if (opened) fido_dev_close(value); fido_dev_free(&value); } }
};
struct Capabilities { fido_cbor_info_t* value = fido_cbor_info_new(); ~Capabilities() { if (value) fido_cbor_info_free(&value); } };
struct Secret { std::string value; ~Secret() { if (!value.empty()) OPENSSL_cleanse(value.data(), value.size()); } };
struct DeviceList { fido_dev_info_t* value = fido_dev_info_new(16); ~DeviceList() { if (value) fido_dev_info_free(&value, 16); } };
napi_value enumerate(napi_env e, napi_callback_info) {
  try {
    fido_init(0); DeviceList owned; auto* list = owned.value; require(list != nullptr);
    size_t count = 0; const int code = fido_dev_info_manifest(list, 16, &count); require(count <= 16); auto out = result(e, code);
    napi_value devices; check(napi_create_array_with_length(e, count, &devices));
    for (size_t i = 0; i < count; ++i) {
      const auto* info = fido_dev_info_ptr(list, i); auto d = object(e);
      set(e, d, "path", text(e, fido_dev_info_path(info) ? fido_dev_info_path(info) : ""));
      const char* maker = fido_dev_info_manufacturer_string(info); const char* product = fido_dev_info_product_string(info);
      set(e, d, "name", text(e, std::string(maker ? maker : "") + " " + (product ? product : "")));
      check(napi_set_element(e, devices, i, d));
    }
    set(e, out, "devices", devices); return out;
  } catch (...) { napi_throw_type_error(e, nullptr, "Invalid native enumeration request"); return nullptr; }
}
napi_value info(napi_env e, napi_callback_info call) {
  try {
    size_t argc = 1; napi_value a[1]; check(napi_get_cb_info(e, call, &argc, a, nullptr, nullptr)); require(argc == 1);
    fido_init(0); Device d(string(e, a[0])); auto out = result(e, d.opened ? FIDO_OK : FIDO_ERR_RX);
    if (!d.opened) return out;
    boolean(e, out, "fido2", fido_dev_is_fido2(d.value)); boolean(e, out, "pinSet", fido_dev_has_pin(d.value));
    boolean(e, out, "uvSet", fido_dev_has_uv(d.value));
    int retries = -1; if (fido_dev_has_pin(d.value)) fido_dev_get_retry_count(d.value, &retries); number(e, out, "retries", retries);
    return out;
  } catch (...) { napi_throw_type_error(e, nullptr, "Invalid native information request"); return nullptr; }
}
napi_value assertion(napi_env e, napi_callback_info call) {
  fido_assert_t* assertion = nullptr; Secret pin;
  try {
    size_t argc = 1; napi_value a[1]; check(napi_get_cb_info(e, call, &argc, a, nullptr, nullptr)); require(argc == 1);
    auto input = a[0]; const std::string path = string(e, get(e, input, "path")); const std::string rp = string(e, get(e, input, "rpId"), 2048);
    auto hash = bytes(e, get(e, input, "hash"), 32); require(hash.size() == 32);
    bool uv = false, u2f = false; check(napi_get_value_bool(e, get(e, input, "uv"), &uv)); check(napi_get_value_bool(e, get(e, input, "u2f"), &u2f));
    pin.value = string(e, get(e, input, "pin"), 63);
    uint32_t count = 0; auto allowed = get(e, input, "allowCredentials"); check(napi_get_array_length(e, allowed, &count)); require(count <= 64);
    std::vector<std::vector<unsigned char>> ids;
    for (uint32_t i = 0; i < count; ++i) { napi_value id; check(napi_get_element(e, allowed, i, &id)); ids.push_back(bytes(e, id, 1024)); }
    fido_init(0); Device d(path); if (!d.opened) return result(e, FIDO_ERR_RX);
    if (u2f) { require(!uv && !ids.empty()); fido_dev_force_u2f(d.value); }
    const bool legacy = u2f || !fido_dev_is_fido2(d.value);
    if (legacy && ids.empty()) return result(e, FIDO_ERR_NO_CREDENTIALS);
    uint64_t maximumCount = 0, maximumLength = 0, maximumMessage = 0;
    if (!legacy) {
      Capabilities capabilities; require(capabilities.value != nullptr);
      const int infoCode = fido_dev_get_cbor_info(d.value, capabilities.value);
      if (infoCode != FIDO_OK) return result(e, infoCode);
      maximumCount = fido_cbor_info_maxcredcntlst(capabilities.value);
      maximumLength = fido_cbor_info_maxcredidlen(capabilities.value);
      maximumMessage = fido_cbor_info_maxmsgsiz(capabilities.value);
    }
    const auto batches = security_key::credentialBatches(ids, maximumCount, maximumLength, legacy, maximumMessage, rp.size());
    security_key::Ids selected;
    fido_dev_set_timeout(d.value, 60000);
    const int code = security_key::tryBatches(batches, FIDO_ERR_NO_CREDENTIALS, [&](const security_key::Ids& batch) {
      if (assertion) fido_assert_free(&assertion);
      assertion = fido_assert_new(); require(assertion != nullptr);
      selected = batch;
      int status = fido_assert_set_rp(assertion, rp.c_str());
      if (status == FIDO_OK) status = fido_assert_set_clientdata_hash(assertion, hash.data(), hash.size());
      for (const auto& id : batch) if (status == FIDO_OK) status = fido_assert_allow_cred(assertion, id.data(), id.size());
      if (status == FIDO_OK) status = fido_assert_set_up(assertion, FIDO_OPT_TRUE);
      if (status == FIDO_OK) status = fido_assert_set_uv(assertion, uv ? FIDO_OPT_TRUE : FIDO_OPT_OMIT);
      if (status == FIDO_OK) status = fido_dev_get_assert(d.value, assertion, pin.value.empty() ? nullptr : pin.value.c_str());
      return status;
    });
    auto out = result(e, code);
    if (code == FIDO_OK) {
      const size_t n = fido_assert_count(assertion); require(n > 0 && n <= 64); napi_value items; check(napi_create_array_with_length(e, n, &items));
      for (size_t i = 0; i < n; ++i) {
        const unsigned char flags = fido_assert_flags(assertion, i); require((flags & 1) != 0 && (!uv || (flags & 4) != 0));
        const auto id = security_key::assertionId(fido_assert_id_ptr(assertion, i), fido_assert_id_len(assertion, i), selected);
        auto r = object(e); set(e, r, "id", buffer(e, id.data(), id.size()));
        set(e, r, "authenticatorData", buffer(e, fido_assert_authdata_raw_ptr(assertion, i), fido_assert_authdata_raw_len(assertion, i)));
        set(e, r, "signature", buffer(e, fido_assert_sig_ptr(assertion, i), fido_assert_sig_len(assertion, i)));
        set(e, r, "userHandle", buffer(e, fido_assert_user_id_ptr(assertion, i), fido_assert_user_id_len(assertion, i)));
        const char* name = fido_assert_user_name(assertion, i); set(e, r, "name", text(e, name ? name : "")); check(napi_set_element(e, items, i, r));
      }
      set(e, out, "assertions", items);
    }
    fido_assert_free(&assertion); return out;
  } catch (...) {
    if (assertion) fido_assert_free(&assertion);
    napi_throw_type_error(e, nullptr, "Invalid native assertion request"); return nullptr;
  }
}
napi_value init(napi_env e, napi_value exports) {
  // The statically linked crypto implementation must not read a host OpenSSL
  // configuration or try loading providers from its build-cache prefix.
  if (OPENSSL_init_crypto(OPENSSL_INIT_NO_LOAD_CONFIG, nullptr) != 1) {
    napi_throw_error(e, nullptr, "Native crypto initialization failed"); return nullptr;
  }
  for (const auto& item : std::vector<std::pair<const char*, napi_callback>>{{"enumerate", enumerate}, {"info", info}, {"assert", assertion}}) {
    napi_value fn; check(napi_create_function(e, item.first, NAPI_AUTO_LENGTH, item.second, nullptr, &fn)); set(e, exports, item.first, fn);
  }
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
