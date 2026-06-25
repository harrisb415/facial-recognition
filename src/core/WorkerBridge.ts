// Minimal typed request/response RPC over postMessage, with transferable
// object support (e.g. ImageBitmap, ArrayBuffer) to avoid structured-clone
// copies of camera frames. Used by App/EnrollmentFlow to talk to
// detector.worker.ts and embedder.worker.ts. See
// offline-face-recognition-spec.md §2.1 and FILE_MAP_AND_TODO.md.

interface RpcRequest<TMethod extends string = string, TParams = unknown> {
  id: number;
  method: TMethod;
  params: TParams;
}

interface RpcSuccess<TResult = unknown> {
  id: number;
  ok: true;
  result: TResult;
}

interface RpcFailure {
  id: number;
  ok: false;
  error: string;
}

type RpcResponse<TResult = unknown> = RpcSuccess<TResult> | RpcFailure;

/** Main-thread side: wraps a Worker, exposes a call() that returns a Promise. */
export class WorkerBridge {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private worker: Worker) {
    this.worker.addEventListener('message', this.handleMessage);
  }

  call<TParams, TResult>(method: string, params: TParams, transfer: Transferable[] = []): Promise<TResult> {
    const id = this.nextId++;
    const request: RpcRequest<string, TParams> = { id, method, params };
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage(request, transfer);
    });
  }

  terminate(): void {
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.terminate();
    for (const { reject } of this.pending.values()) {
      reject(new Error('WorkerBridge terminated with pending calls'));
    }
    this.pending.clear();
  }

  private handleMessage = (event: MessageEvent<RpcResponse>): void => {
    const response = event.data;
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    if (response.ok) {
      entry.resolve(response.result);
    } else {
      entry.reject(new Error(response.error));
    }
  };
}

/**
 * Worker-side helper: registers method handlers and wires them to
 * self.onmessage, replying with the RpcResponse envelope. Call this once
 * from each worker entry file.
 */
export function registerWorkerHandlers(
  handlers: Record<string, (params: unknown) => Promise<unknown> | unknown>,
): void {
  self.addEventListener('message', async (event: MessageEvent<RpcRequest>) => {
    const { id, method, params } = event.data;
    const handler = handlers[method];
    if (!handler) {
      const failure: RpcFailure = { id, ok: false, error: `Unknown method: ${method}` };
      (self as unknown as Worker).postMessage(failure);
      return;
    }
    try {
      const result = await handler(params);
      const success: RpcSuccess = { id, ok: true, result };
      (self as unknown as Worker).postMessage(success);
    } catch (err) {
      const failure: RpcFailure = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
      (self as unknown as Worker).postMessage(failure);
    }
  });
}
