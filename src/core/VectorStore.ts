// IndexedDB persistence for enrollments, consent records, and (optional) match
// events. Embeddings + metadata are encrypted at rest via CryptoService; only
// random UUIDs are kept as plaintext index keys. See
// offline-face-recognition-spec.md §6 for the full storage/security design.

import { openDB, type IDBPDatabase } from 'idb';
import type { ConsentRecord, EnrollmentRecord, MatchEvent } from '../types';
import { CryptoService, type EncryptedPayload } from './CryptoService';

const DB_NAME = 'face-recognition-db';
const DB_VERSION = 1;

interface StoredEnrollment {
  id: string;
  consentRecordId: string;
  payload: EncryptedPayload; // encrypted EnrollmentRecord (embedding as number[], not Float32Array)
}

interface StoredConsent {
  id: string;
  subjectLabel: string;
  payload: EncryptedPayload; // encrypted ConsentRecord
}

type SerializedEnrollment = Omit<EnrollmentRecord, 'embedding'> & { embedding: number[] };

export class VectorStore {
  private dbPromise: Promise<IDBPDatabase>;

  constructor(private crypto: CryptoService) {
    this.dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const enrollments = db.createObjectStore('enrollments', { keyPath: 'id' });
        enrollments.createIndex('consentRecordId', 'consentRecordId');

        const consents = db.createObjectStore('consents', { keyPath: 'id' });
        consents.createIndex('subjectLabel', 'subjectLabel');

        db.createObjectStore('matchEvents', { keyPath: 'id' }).createIndex(
          'timestamp',
          'timestamp',
        );

        db.createObjectStore('meta', { keyPath: 'key' });
      },
    });
  }

  // --- Enrollments ---

  async putEnrollment(record: EnrollmentRecord): Promise<void> {
    const serializable: SerializedEnrollment = {
      ...record,
      embedding: Array.from(record.embedding),
    };
    const payload = await this.crypto.encryptJson(serializable);
    const stored: StoredEnrollment = { id: record.id, consentRecordId: record.consentRecordId, payload };
    const db = await this.dbPromise;
    await db.put('enrollments', stored);
  }

  async getEnrollment(id: string): Promise<EnrollmentRecord | undefined> {
    const db = await this.dbPromise;
    const stored: StoredEnrollment | undefined = await db.get('enrollments', id);
    if (!stored) return undefined;
    return this.deserializeEnrollment(stored);
  }

  async getAllEnrollments(): Promise<EnrollmentRecord[]> {
    const db = await this.dbPromise;
    const all: StoredEnrollment[] = await db.getAll('enrollments');
    return Promise.all(all.map((s) => this.deserializeEnrollment(s)));
  }

  async deleteEnrollment(id: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete('enrollments', id);
  }

  /** Deletes every enrollment tied to a given consent record (consent withdrawal cascade). */
  async deleteEnrollmentsByConsent(consentRecordId: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction('enrollments', 'readwrite');
    const index = tx.store.index('consentRecordId');
    let cursor = await index.openCursor(consentRecordId);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  private async deserializeEnrollment(stored: StoredEnrollment): Promise<EnrollmentRecord> {
    const decrypted = await this.crypto.decryptJson<SerializedEnrollment>(stored.payload);
    return { ...decrypted, embedding: Float32Array.from(decrypted.embedding) };
  }

  // --- Consents ---

  async putConsent(record: ConsentRecord): Promise<void> {
    const payload = await this.crypto.encryptJson(record);
    const stored: StoredConsent = { id: record.id, subjectLabel: record.subjectLabel, payload };
    const db = await this.dbPromise;
    await db.put('consents', stored);
  }

  async getConsent(id: string): Promise<ConsentRecord | undefined> {
    const db = await this.dbPromise;
    const stored: StoredConsent | undefined = await db.get('consents', id);
    if (!stored) return undefined;
    return this.crypto.decryptJson<ConsentRecord>(stored.payload);
  }

  /** Revokes consent and cascade-deletes associated biometric data (spec §6.3). */
  async revokeConsent(id: string): Promise<void> {
    const consent = await this.getConsent(id);
    if (!consent) return;
    const revoked: ConsentRecord = { ...consent, revoked: true, revokedAt: new Date().toISOString() };
    await this.putConsent(revoked);
    await this.deleteEnrollmentsByConsent(id);
  }

  // --- Match events (opt-in audit log; see config.storage.auditLogEnabled) ---

  async appendMatchEvent(event: MatchEvent, maxEntries: number): Promise<void> {
    const db = await this.dbPromise;
    await db.put('matchEvents', event);
    if (maxEntries > 0) {
      const all = await db.getAllFromIndex('matchEvents', 'timestamp');
      const excess = all.length - maxEntries;
      for (let i = 0; i < excess; i++) {
        await db.delete('matchEvents', all[i].id);
      }
    }
  }

  // --- Similarity search ---

  /** Cosine similarity match against all stored enrollments. O(n) — fine for small n; see spec §4.3. */
  async findBestMatch(
    queryEmbedding: Float32Array,
  ): Promise<{ enrollment: EnrollmentRecord; similarity: number } | null> {
    const enrollments = await this.getAllEnrollments();
    let best: { enrollment: EnrollmentRecord; similarity: number } | null = null;
    for (const enrollment of enrollments) {
      const similarity = cosineSimilarity(queryEmbedding, enrollment.embedding);
      if (!best || similarity > best.similarity) {
        best = { enrollment, similarity };
      }
    }
    return best;
  }

  // --- Wipe (right-to-erasure, spec §6.3) ---

  async wipeAll(): Promise<void> {
    const db = await this.dbPromise;
    await Promise.all([
      db.clear('enrollments'),
      db.clear('consents'),
      db.clear('matchEvents'),
    ]);
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Embeddings are expected to already be L2-normalized (see Embedder.ts),
  // so dot product alone equals cosine similarity. Re-normalizing defensively
  // here would mask a bug upstream if vectors are ever not unit length.
  return dot;
}
