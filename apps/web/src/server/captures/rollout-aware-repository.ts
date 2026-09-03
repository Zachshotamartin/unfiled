import type { EncryptionRolloutStateSource } from "@/server/product/rollout-aware-repository";

import type { CaptureRepository, CaptureRepositoryContext } from "./repository";

export type CaptureRepositoryMethod = keyof CaptureRepository;

const WRITE_METHODS = new Set<CaptureRepositoryMethod>([
  "createCapture",
  "deleteCapture",
  "retryCapture",
  "createAttachment"
]);

/** Photos and recordings have no legacy storage; they always take the encrypted path. */
const ENCRYPTED_ONLY_METHODS = new Set<CaptureRepositoryMethod>([
  "createAttachment",
  "getAttachment"
]);

export function captureRepositoryTarget(
  state: Awaited<ReturnType<EncryptionRolloutStateSource["stateForOwner"]>>,
  method: CaptureRepositoryMethod
): "encrypted" | "legacy" {
  if (ENCRYPTED_ONLY_METHODS.has(method)) return "encrypted";
  if (state === "expanded") return "legacy";
  if (state === "dual_write" && !WRITE_METHODS.has(method)) return "legacy";
  return "encrypted";
}

/**
 * Selects one repository only after an authoritative state lookup. Lookup,
 * projection, and encrypted-runtime failures propagate; none can downgrade an
 * operation to the legacy repository.
 */
export class RolloutAwareCaptureRepository implements CaptureRepository {
  public constructor(
    private readonly rollout: EncryptionRolloutStateSource,
    private readonly legacy: CaptureRepository,
    private readonly encrypted: CaptureRepository
  ) {}

  private async selected(
    context: CaptureRepositoryContext,
    method: CaptureRepositoryMethod
  ): Promise<CaptureRepository> {
    const state = await this.rollout.stateForOwner(context);
    return captureRepositoryTarget(state, method) === "encrypted" ? this.encrypted : this.legacy;
  }

  public async createCapture(...parameters: Parameters<CaptureRepository["createCapture"]>) {
    return (await this.selected(parameters[0], "createCapture")).createCapture(...parameters);
  }

  public async deleteCapture(...parameters: Parameters<CaptureRepository["deleteCapture"]>) {
    return (await this.selected(parameters[0], "deleteCapture")).deleteCapture(...parameters);
  }

  public async getCapture(...parameters: Parameters<CaptureRepository["getCapture"]>) {
    return (await this.selected(parameters[0], "getCapture")).getCapture(...parameters);
  }

  public async getReceipt(...parameters: Parameters<CaptureRepository["getReceipt"]>) {
    return (await this.selected(parameters[0], "getReceipt")).getReceipt(...parameters);
  }

  public async listCaptures(...parameters: Parameters<CaptureRepository["listCaptures"]>) {
    return (await this.selected(parameters[0], "listCaptures")).listCaptures(...parameters);
  }

  public async retryCapture(...parameters: Parameters<CaptureRepository["retryCapture"]>) {
    return (await this.selected(parameters[0], "retryCapture")).retryCapture(...parameters);
  }

  public async createAttachment(...parameters: Parameters<CaptureRepository["createAttachment"]>) {
    return (await this.selected(parameters[0], "createAttachment")).createAttachment(...parameters);
  }

  public async getAttachment(...parameters: Parameters<CaptureRepository["getAttachment"]>) {
    return (await this.selected(parameters[0], "getAttachment")).getAttachment(...parameters);
  }
}
