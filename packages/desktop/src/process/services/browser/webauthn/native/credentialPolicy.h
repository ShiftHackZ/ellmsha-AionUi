#pragma once
#include <algorithm>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace security_key {
using Id = std::vector<unsigned char>;
using Ids = std::vector<Id>;
// Size only; libfido2 still owns all CBOR/CTAP serialization. For this fixed
// getAssertion shape, 256 + RP bytes bounds the command/map, RP and hash,
// allow-list header, UP/UV options, 32-byte PIN-UV auth and protocol fields.
// Each {type:"public-key", id:bytes} needs at most 64 + ID bytes, counting
// even nine-byte CBOR headers. This deliberately overestimates small headers.
// maxMsgSize absent means CTAP2's 1024-byte default. U2F has no CBOR list.
inline std::vector<Ids> credentialBatches(const Ids& ids, uint64_t count, uint64_t length, bool u2f,
    uint64_t messageSize = 0, size_t rpLength = 0) {
  const uint64_t maximumMessage = messageSize ? messageSize : 1024;
  const uint64_t envelope = 256 + static_cast<uint64_t>(rpLength);
  if (!u2f && envelope > maximumMessage) return {};
  if (ids.empty()) return {Ids{}}; // Explicit discoverable request only.
  const size_t maximumCount = u2f ? 1 : static_cast<size_t>(std::min<uint64_t>(count ? count : 1, 64));
  const size_t maximumLength = u2f ? 255 : static_cast<size_t>(std::min<uint64_t>(length ? length : 1024, 1024));
  std::vector<Ids> batches;
  uint64_t used = envelope;
  for (const auto& id : ids) {
    if (id.empty() || id.size() > maximumLength) continue;
    const uint64_t descriptor = 64 + static_cast<uint64_t>(id.size());
    if (!u2f && descriptor > maximumMessage - envelope) continue;
    if (batches.empty() || batches.back().size() == maximumCount ||
        (!u2f && descriptor > maximumMessage - used)) {
      batches.emplace_back();
      used = envelope;
    }
    batches.back().push_back(id);
    used += descriptor;
  }
  return batches; // Empty after filtering must never become discoverable.
}
inline Id assertionId(const unsigned char* data, size_t size, const Ids& allowed) {
  if (size) {
    if (!data || size > 1024) throw std::runtime_error("Invalid credential ID");
    Id id(data, data + size);
    if (!allowed.empty() && std::find(allowed.begin(), allowed.end(), id) == allowed.end())
      throw std::runtime_error("Unexpected credential ID");
    return id;
  }
  if (allowed.size() != 1) throw std::runtime_error("Ambiguous credential ID");
  return allowed.front(); // CTAP2.0 permits omission for a single allowCredential.
}
template <class Attempt> int tryBatches(const std::vector<Ids>& batches, int noCredentials, Attempt attempt) {
  for (const auto& batch : batches) {
    const int code = attempt(batch);
    if (code != noCredentials) return code; // Never retry PIN/UV, transport or unknown errors.
  }
  return noCredentials;
}
}
