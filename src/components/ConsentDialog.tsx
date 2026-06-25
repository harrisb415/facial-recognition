// Explicit consent gate. No frame may reach the detection worker before this
// resolves with `granted: true`. Default copy mirrors privacy-and-testing.md
// §2 ("Consent UI text") — keep them in sync if you edit either.

import { useState } from 'react';
import type { ConsentScope } from '../types';

export const CONSENT_TEXT_VERSION = '1.0.0';

export interface ConsentDialogProps {
  scope: ConsentScope;
  onDecision: (decision: { granted: boolean; scope: ConsentScope; textVersion: string }) => void;
}

const DEFAULT_BODY_BY_SCOPE: Record<ConsentScope, string> = {
  enrollment:
    'This will use your device camera to capture your face and create a mathematical ' +
    'representation (an "embedding") of it, stored only on this device, encrypted, and never ' +
    'uploaded anywhere. The camera image itself is not saved. You can delete this data at any ' +
    'time from settings.',
  matching:
    'This will use your device camera to check whether your face matches an embedding already ' +
    'stored on this device. The camera image is not saved. Nothing is uploaded anywhere.',
  'enrollment+matching':
    'This will use your device camera both to enroll your face (store an encrypted embedding on ' +
    'this device) and to check future matches against it. The camera image itself is never saved ' +
    'or uploaded. You can delete this data at any time from settings.',
};

export function ConsentDialog({ scope, onDecision }: ConsentDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="consent-title" className="consent-dialog">
      <h2 id="consent-title">Camera & face data consent</h2>
      <p>{DEFAULT_BODY_BY_SCOPE[scope]}</p>
      <ul>
        <li>Processing happens entirely on this device — nothing is sent over the network.</li>
        <li>Data is encrypted at rest on this device.</li>
        <li>You may withdraw consent at any time, which deletes the stored data immediately.</li>
      </ul>
      <label className="consent-dialog__ack">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        I understand and agree to the above.
      </label>
      <div className="consent-dialog__actions">
        <button
          type="button"
          onClick={() => onDecision({ granted: false, scope, textVersion: CONSENT_TEXT_VERSION })}
        >
          Decline
        </button>
        <button
          type="button"
          disabled={!acknowledged}
          onClick={() => onDecision({ granted: true, scope, textVersion: CONSENT_TEXT_VERSION })}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
