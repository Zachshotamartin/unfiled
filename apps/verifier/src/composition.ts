import type { VerifierConfig } from "./config.js";
import { createGenerationVerificationRepository } from "./database.js";
import { createVerifierApp, type VerifierApp } from "./http.js";
import { createProductionInvocationAuth } from "./invocation-auth.js";
import { createVerifierKmsAdapter } from "./kms.js";
import { createPostgresVerifierExecutor } from "./postgres.js";
import { createGenerationVerifier } from "./verifier.js";

export type VerifierComposition = Readonly<{
  app: VerifierApp;
  close(): Promise<void>;
}>;

export function createVerifierComposition(config: VerifierConfig): VerifierComposition {
  if (config.verification.kind === "disabled") {
    return Object.freeze({
      app: createVerifierApp({ config }),
      close(): Promise<void> {
        return Promise.resolve();
      }
    });
  }
  const postgres = createPostgresVerifierExecutor(config.verification.database);
  const repository = createGenerationVerificationRepository(postgres.executor);
  const verifier = createGenerationVerifier({
    decryptConcurrency: config.verification.decryptConcurrency,
    repository
  });
  return Object.freeze({
    app: createVerifierApp({
      config,
      kms: createVerifierKmsAdapter(),
      productionInvocationAuth: createProductionInvocationAuth(config.verification.invocation),
      verifier
    }),
    close: postgres.close
  });
}
