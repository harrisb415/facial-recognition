// Persistent local encryption key for the demo. A non-extractable AES-GCM
// CryptoKey is generated once and stored in IndexedDB, then reused on every
// subsequent page load. This is what lets enrollments stored in one session
// still be decryptable after a reload — without it, a fresh random key each
// load makes all previously stored (encrypted) records unreadable.
//
// Storing a non-extractable CryptoKey in IndexedDB is the standard "keep a key
// without exposing its material" pattern: structured clone (which IndexedDB
// uses) supports CryptoKey, and a non-extractable key still cannot be exported
// even after being read back. It protects against casual inspection of the
// data store, NOT against a local attacker with full device access — see
// offline-face-recognition-spec.md §6.2. A real product should derive the key
// from a host-supplied passphrase/PIN via CryptoService.initializeFromPassphrase
// instead; this keyStore is the demo's no-passphrase convenience.

import { openDB } from 'idb';

const KEY_DB = 'face-recognition-keys';
const KEY_STORE = 'keys';
const KEY_ID = 'local-aes-gcm-v1';

export async function getOrCreatePersistentKey(): Promise<CryptoKey> {
  const db = await openDB(KEY_DB, 1, {
    upgrade(database) {
      database.createObjectStore(KEY_STORE);
    },
  });

  const existing = (await db.get(KEY_STORE, KEY_ID)) as CryptoKey | undefined;
  if (existing) return existing;

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  await db.put(KEY_STORE, key, KEY_ID);
  return key;
}
