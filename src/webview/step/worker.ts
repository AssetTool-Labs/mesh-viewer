import { tessellateStep, type StepTessellationResult } from './tessellate';
import { decodeText } from '../textEncoding';

export interface StepWorkerRequest {
  readonly source: ArrayBuffer;
}

export type StepWorkerResponse =
  | { readonly ok: true; readonly result: StepTessellationResult }
  | { readonly ok: false; readonly message: string };

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<StepWorkerRequest>) => void) | null;
  postMessage(message: StepWorkerResponse, transfer?: Transferable[]): void;
};

worker.onmessage = (event: MessageEvent<StepWorkerRequest>) => {
  try {
    const source = decodeText(event.data.source);
    const response: StepWorkerResponse = { ok: true, result: tessellateStep(source) };
    const transfer = response.result.meshes.flatMap((mesh) => [
      mesh.positions.buffer,
      mesh.normals.buffer,
      mesh.colors.buffer,
      mesh.indices.buffer,
    ]) as ArrayBuffer[];
    worker.postMessage(response, transfer);
  } catch (error) {
    const response: StepWorkerResponse = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
    worker.postMessage(response);
  }
};