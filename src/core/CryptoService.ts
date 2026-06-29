// Web Crypto wrapper for at-rest encryption of enrollment/consent records.
// See offline-face-recognition-spec.md §6.2. AES-GCM 256-bit, random 96-bit IV
// per operation. Key is derived from a passphrase supplied by the host app,
// or generated once and held non-extractably if no passphrase is supplied.

const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedPayload {
  iv: string; // base64
  ciphertext: string; // base64
}

function toBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export class CryptoService {
  private key: CryptoKey | null = null;

  /** Derive an AES-GCM key from a host-supplied passphrase + stored salt. */
  async initializeFromPassphrase(passphrase: string, salt: Uint8Array): Promise<void> {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    this.key = await crypto.subtle.deriveKey(
      // TS's lib.dom.d.ts types BufferSource as requiring an ArrayBuffer-backed
      // view specifically; Uint8Array.prototype.buffer is typed as the more
      // general ArrayBufferLike. Runtime behavior is unaffected — cast needed
      // purely to satisfy the stricter type, see same pattern below.
      { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false, // not extractable
      ['encrypt', 'decrypt'],
    );
  }

  /**
   * No-passphrase fallback: generate a random non-extractable key. This protects
   * against casual inspection of IndexedDB contents but NOT against a local
   * attacker with full device access. Document this honestly to integrators —
   * see README.md §8 and offline-face-recognition-spec.md §6.2.
   */
  async initializeRandomKey(): Promise<void> {
    this.key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
  }

  /**
   * Use an already-derived/loaded key (e.g. the persistent local key from
   * keyStore.getOrCreatePersistentKey). The key must support encrypt+decrypt.
   * This is how the demo gets a STABLE key across page loads — initializeRandomKey
   * regenerates each load, which makes previously stored records undecryptable.
   */
  initializeWithKey(key: CryptoKey): void {
    this.key = key;
  }

  static generateSalt(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  }

  async encryptJson(value: unknown): Promise<EncryptedPayload> {
    if (!this.key) throw new Error('CryptoService not initialized');
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, plaintext);
    return {
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
    };
  }

  async decryptJson<T>(payload: EncryptedPayload): Promise<T> {
    if (!this.key) throw new Error('CryptoService not initialized');
    const iv = fromBase64(payload.iv);
    const ciphertext = fromBase64(payload.ciphertext);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      this.key,
      ciphertext as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  }

  isInitialized(): boolean {
    return this.key !== null;
  }
}
