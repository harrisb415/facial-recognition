# Privacy Checklist, Consent Copy, and Testing Plan

Companion to [offline-face-recognition-spec.md](offline-face-recognition-spec.md). This document is normative for anyone integrating this component system into a real product — read it before wiring up enrollment or matching against real users.

---

## 1. Privacy checklist

Use this as a literal pre-launch checklist. Every item should be independently verifiable (by code inspection or by direct testing), not just asserted.

### Data minimization

- [ ] Raw camera frames are never persisted to disk, IndexedDB, or any storage API. They exist only as in-memory `ImageBitmap`/`ImageData`/`Uint8ClampedArray` objects during the active capture session and are discarded (not just dereferenced — explicitly `close()`d for `ImageBitmap`, see `CameraCapture.tsx` and the worker entry files) immediately after use.
- [ ] Aligned face crops (the 112×112 RGB buffer produced by `Aligner`) are never persisted. Verify by inspecting `EnrollmentRecord`/`MatchEvent` — neither type has a pixel-buffer field.
- [ ] Only the embedding vector (a float array with no direct visual interpretation) and minimal metadata (label, timestamps, consent linkage, quality/liveness scores) are stored.
- [ ] Match events (audit log) are **off by default** (`config.storage.auditLogEnabled = false`). If enabled, they are bounded (`auditLogMaxEntries`) and auto-pruned — verify `VectorStore.appendMatchEvent()`'s pruning logic actually runs, don't just trust the config default.
- [ ] No analytics/telemetry SDK is present anywhere in `package.json` or `src/`. If you add one for your own product, it must not receive any biometric data, frame data, or embedding — verify by checking exactly what payload any added telemetry call sends, not just trusting the SDK's marketing claims about "anonymization."

### Consent

- [ ] No frame reaches the detection worker before a `ConsentRecord` exists for the relevant scope (`enrollment` and/or `matching`) — trace the code path from `CameraCapture`'s `enabled` prop back to the consent gate in `App.tsx`/`EnrollmentFlow.tsx` and confirm there is no route that sets `enabled={true}` without a prior granted decision.
- [ ] Consent text version (`CONSENT_TEXT_VERSION` in `ConsentDialog.tsx`) is stored alongside each `ConsentRecord`. If you edit the consent copy, bump that version string — old records should remain attributable to the copy the subject actually saw.
- [ ] Declining consent leads to a dead-end state (`IDLE`/`failed`), never a silent retry or a path that proceeds anyway.
- [ ] Revoking consent (`VectorStore.revokeConsent()`) cascade-deletes the associated `EnrollmentRecord`(s) — this is not optional or "soft delete," see spec §6.3. Verify by direct IndexedDB inspection after calling it.

### Encryption / storage

- [ ] `CryptoService` is initialized (either `initializeFromPassphrase` or `initializeRandomKey`) before any `VectorStore` write. Verify `VectorStore`'s constructor requires a `CryptoService` instance — it does by type signature, but confirm nothing bypasses it.
- [ ] IndexedDB inspection (DevTools → Application → IndexedDB) after a real enroll+match cycle shows only ciphertext (`iv` + `ciphertext` base64 blobs) in the `enrollments`/`consents` stores — no readable label, no readable embedding values.
- [ ] If using `initializeRandomKey()` (no host-supplied passphrase), the limitation is documented to whoever deploys this: it protects against casual inspection, not against a local attacker with full device/profile access. Don't let this caveat get lost between this doc and the actual deployed product's user-facing privacy notice.

### Network

- [ ] DevTools Network tab, during a full enroll+match cycle with models already cached, shows **zero** requests. (One-time model fetch on first load is expected and fine — re-verify it disappears on reload.)
- [ ] No code path constructs a `fetch`/`XMLHttpRequest`/`WebSocket`/`navigator.sendBeacon` call targeting any non-same-origin URL. Grep the codebase for these APIs as a final check before shipping, not just during initial development — a dependency upgrade or copy-pasted snippet could introduce one later.

### Deletion / right-to-erasure

- [ ] A user-facing affordance exists to delete a single enrollment (`VectorStore.deleteEnrollment`) and to wipe everything (`VectorStore.wipeAll`). "Exists in the API" is not sufficient — confirm it's actually reachable from the UI before launch.
- [ ] Deletion is immediate and synchronous from the user's perspective (no "deletion takes effect in 30 days" patterns — there's no backend to propagate to; local deletion should just work).

### Scope discipline

- [ ] Re-read [offline-face-recognition-spec.md](offline-face-recognition-spec.md) §1.1 ("Explicit non-goals") before extending this system to any use case involving non-consenting subjects, continuous public-space scanning, or any watchlist-matching pattern. This component system is designed for consensual, single-subject, opted-in interactions. If your product idea doesn't fit that description, stop and reconsider — this is not a policy detail, it's a design boundary the architecture (consent-gated, single local device, no centralized matching across devices) assumes throughout.

---

## 2. Consent UI text

Canonical source for this copy is [src/components/ConsentDialog.tsx](src/components/ConsentDialog.tsx) (`DEFAULT_BODY_BY_SCOPE`). Reproduced here for review/translation/legal-review purposes — if you edit one, edit both and bump `CONSENT_TEXT_VERSION`.

### Enrollment scope

> **Camera & face data consent**
>
> This will use your device camera to capture your face and create a mathematical representation (an "embedding") of it, stored only on this device, encrypted, and never uploaded anywhere. The camera image itself is not saved. You can delete this data at any time from settings.
>
> - Processing happens entirely on this device — nothing is sent over the network.
> - Data is encrypted at rest on this device.
> - You may withdraw consent at any time, which deletes the stored data immediately.
>
> ☐ I understand and agree to the above.
>
> [Decline] [Continue]

### Matching scope

> **Camera & face data consent**
>
> This will use your device camera to check whether your face matches an embedding already stored on this device. The camera image is not saved. Nothing is uploaded anywhere.
>
> - Processing happens entirely on this device — nothing is sent over the network.
> - Data is encrypted at rest on this device.
> - You may withdraw consent at any time, which deletes the stored data immediately.
>
> ☐ I understand and agree to the above.
>
> [Decline] [Continue]

### Liveness-check failure (non-accusatory by design)

> We couldn't confirm a live face. Make sure you're in good lighting and try again.

Deliberately avoids language like "spoof detected" or "fraud suspected" — a failed liveness check is very often a false negative (bad lighting, motion blur, an unusual but legitimate camera angle), and accusatory copy is both a poor user experience and a fairness concern (see §3.3 below on uneven false-negative rates across skin tones/lighting conditions).

### Debug/export mode (only if you build this optional feature — off by default)

> **Debug export consent (separate from normal enrollment)**
>
> Enabling this will save an actual image of your face on this device for debugging purposes, in addition to the encrypted embedding. This is more sensitive than normal enrollment. This image stays on this device and is not uploaded, but it is not encrypted by default treatment under this consent and can be viewed by anyone with access to this device's files. Only enable this if you understand and accept that risk.
>
> ☐ I understand this saves an actual face image, not just an embedding.
>
> [Decline] [Continue]

---

## 3. Testing plan

### 3.1 Accuracy testing

**Goal:** establish real numbers for `config.embedding.matchThreshold` and `config.liveness.minScore` against the actual model weights you sourced — the shipped defaults (0.62, 0.5) are placeholders, not validated values (spec §13).

1. **Build a local test set.** Capture multiple enrollment images per test subject (minimum ~10 subjects for a meaningful pilot, more before any production decision) across varied lighting, angle, and with/without glasses. This data is sensitive — treat it under the same privacy rules as production data (encrypted storage, deletion after testing, informed consent from test subjects who are presumably colleagues/volunteers, not anonymous public subjects).
2. **Compute genuine-pair and impostor-pair similarity distributions.** For each subject, embed multiple captures and compute cosine similarity between same-subject pairs (genuine) and different-subject pairs (impostor).
3. **Plot/compute the ROC curve** (true accept rate vs. false accept rate across thresholds) from those two distributions. Pick `matchThreshold` based on your product's actual risk tolerance — a kiosk convenience feature can tolerate a higher false-accept rate than anything access-control-adjacent.
4. **Report and store** the chosen threshold's actual FAR/FRR (false accept rate / false reject rate) on your test set alongside the threshold value in your product documentation — "0.62" with no accompanying error-rate data is not a validated threshold, it's a guess with a decimal point.
5. Repeat this process for `liveness.minScore` using real-face vs. printed-photo vs. screen-replay captures.

### 3.2 Performance testing

Validate the targets in spec §7 on your actual hardware matrix, not just a dev laptop:

1. Measure per-stage latency (detection, alignment, embedding, liveness) via `performance.now()` timestamps bracketing each worker RPC call — log these in a dev-only diagnostics overlay, not in production telemetry (see privacy checklist §1 — no telemetry of any per-user data; aggregate, anonymous, opt-in local-only perf logging during your own QA pass is fine, shipping it to any backend is not, since there is no backend).
2. Test across the backend matrix deliberately: force WebGPU off (`navigator.gpu` can be stubbed in a test build, or test on a browser without it), force WebGL off (override `HTMLCanvasElement.prototype.getContext` in a test harness to reject `webgl2` requests), to exercise all three tiers in `offline-model-loading-plan.md` §3.1 — don't rely on only ever testing the best-case backend your dev machine happens to support.
3. Test on at least one genuinely low-end device (older laptop, budget Android tablet) — the WASM-only fallback numbers in spec §7 are meaningless if never actually measured on hardware that hits that path.
4. Re-measure cold-load time (manifest fetch + model fetch/cache + warm-up) on both a throttled-network profile (DevTools "Slow 3G") for first-run, and a fully-offline reload for steady-state — these are different user experiences and both matter.

### 3.3 Bias / fairness testing

Face detection, embedding, and liveness models trained on imbalanced datasets can show meaningfully different error rates across demographic groups (this is a well-documented, repeated finding across the face-recognition research literature, not a hypothetical concern). Before any production use:

1. **Disaggregate your accuracy testing (§3.1) by demographic group** — at minimum skin tone (consider using a standard reference scale rather than ad hoc categorization) and age bracket; gender if relevant to your deployment population. This requires a test set that's deliberately diverse enough to disaggregate, which your initial pilot set (§3.1 step 1) may need to be expanded for.
2. **Compare false-reject and false-accept rates across groups, not just an aggregate average.** A model with a great aggregate FRR can still be substantially worse for specific subgroups; an aggregate number can hide this entirely.
3. **Do the same for the liveness/anti-spoof model** — texture-based heuristics in particular (`textureHeuristic()` in `LivenessModel.ts`) have a plausible failure mode of correlating with skin tone or camera exposure settings in ways that produce uneven false-reject rates. Test this explicitly rather than assuming the heuristic is neutral.
4. **Document findings honestly, including negative ones.** If you find a meaningful disparity and can't fix it before launch (better training data, a different pre-trained model, or a higher liveness/match threshold tuned per findings), that is a launch-blocking issue for any deployment context where unequal treatment of users would be harmful — not a footnote to ship with a caveat.
5. **Re-test after any model swap.** A different SCRFD/MobileFaceNet/anti-spoof weight file (per [models/README.md](models/README.md)) can shift fairness characteristics even if aggregate accuracy looks similar or better — re-run the disaggregated comparison, don't assume it carries over.

### 3.4 Regression testing on consent/privacy behavior

These are correctness properties, not just privacy nice-to-haves — write automated tests for them where feasible (Vitest + a mocked `IndexedDB`/`crypto` environment, see `package.json`'s `test` script) rather than relying solely on manual QA pass-throughs before each release:

- A capture attempt with no granted `ConsentRecord` for the active scope never results in a worker RPC call. (Unit-testable: mock `WorkerBridge.call`, assert it's never invoked before consent dispatch.)
- `revokeConsent()` removes all rows from `enrollments` matching that `consentRecordId`. (Integration-testable against a real or fake-indexeddb instance.)
- `wipeAll()` leaves all three object stores empty.
- Encrypted payloads round-trip correctly (`encryptJson` → `decryptJson` produces the original object) and fail closed (throw, not return garbage) when decrypted with the wrong key.

---

## 4. Explicit limitations to keep surfacing (don't let these get lost over time)

- This is **assistive identification, not strong biometric authentication.** Software-only liveness on a commodity RGB webcam is a deterrent against casual spoofing, not a security guarantee against a motivated attacker with a good mask or replay setup (spec §4.4).
- **Quantized, small models trade some accuracy for size/speed.** If your use case is high-stakes, re-evaluate whether FP32 weights and a larger architecture are warranted, accepting the larger download (models/README.md §2).
- **All defaults in `config.ts` are placeholders** until you run §3.1's testing process against your actual sourced model weights. Shipping the defaults unchanged is shipping an untested guess.
