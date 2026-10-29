import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
it.skipIf(process.platform !== 'darwin')(
  'uses native credential capability/result policy without any device IO',
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'ellmsha-fido-policy-'));
    try {
      const header = path.resolve('packages/desktop/src/process/services/browser/webauthn/native/credentialPolicy.h');
      writeFileSync(
        path.join(directory, 'test.cc'),
        `
#include "${header}"
#include <cassert>
using namespace security_key;
int main() {
  Ids ids{{1}, {2}, {3}, Id(300, 4)};
  auto batches = credentialBatches(ids, 2, 200, false);
  assert(batches.size()==2 && batches[0].size()==2 && batches[1].size()==1);
  assert(credentialBatches(ids, 0, 0, false).size()==4);
  assert(credentialBatches(ids, 9, 999, true).size()==3);
  assert(credentialBatches({Id(300,4)}, 1, 255, false).empty());
  assert(credentialBatches({}, 1, 255, false).size()==1);
  // Count and ID-length limits allow all four; actual message size permits
  // only one descriptor per request, including RP/hash/PIN-UV overhead.
  Ids medium{Id(128,1),Id(128,2),Id(128,3),Id(128,4)};
  auto sized = credentialBatches(medium, 8, 512, false, 512, 12);
  assert(sized.size()==4);
  for (const auto& batch: sized) assert(batch.size()==1);
  assert(credentialBatches(medium,8,512,false,2048,12).size()==1);
  assert(credentialBatches({Id(200,1)},8,512,false,530,10).size()==1);
  assert(credentialBatches({Id(200,1)},8,512,false,529,10).empty());
  assert(credentialBatches({Id(1024,1)},8,1024,false,0,10).empty());
  assert(credentialBatches({Id(1024,1),Id(128,2)},8,1024,false,512,12)==std::vector<Ids>{Ids{Id(128,2)}});
  assert(credentialBatches({},8,1024,false,128,12).empty());
  // A long U2F AppID is hashed by libfido2; it is not sent as CTAP2 RP text.
  assert(credentialBatches({Id(255,1)},8,1024,true,128,2048).size()==1);
  assert(assertionId(nullptr,0,{{8}})==Id{8});
  bool ambiguous=false; try { assertionId(nullptr,0,{{1},{2}}); } catch (...) { ambiguous=true; } assert(ambiguous);
  bool missing=false; try { assertionId(nullptr,0,{}); } catch (...) { missing=true; } assert(missing);
  int calls=0;
  assert(tryBatches(batches, 46, [&](const Ids&) { return ++calls==1 ? 46 : 0; })==0 && calls==2);
  for (int terminal: {0,49,50,54,-1}) {
    calls=0; assert(tryBatches(batches,46,[&](const Ids&) { ++calls; return terminal; })==terminal && calls==1);
  }
  calls=0; assert(tryBatches({},46,[&](const Ids&) { ++calls; return 0; })==46 && calls==0);
}
`
      );
      execFileSync(
        'xcrun',
        ['clang++', '-std=c++17', path.join(directory, 'test.cc'), '-o', path.join(directory, 'test')],
        { timeout: 30000 }
      );
      expect(() => execFileSync(path.join(directory, 'test'), [], { timeout: 3000 })).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
