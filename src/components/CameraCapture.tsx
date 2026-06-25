// getUserMedia lifecycle + frame grabbing. Frames are handed to the caller
// as ImageBitmap (transferable, no extra copy into a worker). No frame is
// ever uploaded anywhere — see offline-face-recognition-spec.md §6.2.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface CameraCaptureProps {
  /** Frames-per-second to sample for the detection pipeline. Default 10. */
  fps?: number;
  enabled: boolean;
  onFrame: (frame: ImageBitmap) => void;
  onError?: (error: Error) => void;
}

export function CameraCapture({ fps = 10, enabled, onFrame, onError }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<number | null>(null);
  const [status, setStatus] = useState<'idle' | 'requesting' | 'streaming' | 'denied' | 'error'>(
    'idle',
  );

  const stop = useCallback(() => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStatus('idle');
  }, []);

  useEffect(() => {
    if (!enabled) {
      stop();
      return;
    }

    let cancelled = false;

    async function start() {
      setStatus('requesting');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStatus('streaming');

        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d');

        intervalRef.current = window.setInterval(async () => {
          if (!videoRef.current || !ctx) return;
          ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
          const bitmap = await createImageBitmap(canvas);
          onFrame(bitmap);
        }, 1000 / fps);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setStatus(error.name === 'NotAllowedError' ? 'denied' : 'error');
        onError?.(error);
      }
    }

    start();

    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fps]);

  return (
    <div className="camera-capture" data-status={status}>
      <video ref={videoRef} muted playsInline className="camera-capture__video" />
      {status === 'denied' && (
        <p role="alert" className="camera-capture__message">
          Camera permission was denied. Grant camera access to continue.
        </p>
      )}
      {status === 'error' && (
        <p role="alert" className="camera-capture__message">
          Could not access the camera. Check that no other application is using it.
        </p>
      )}
    </div>
  );
}
