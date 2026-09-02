import type { SearchConfig } from "./config.js";
import { createEncryptedUserSearchRepository } from "./database.js";
import { createOpenAISearchEmbeddingProvider } from "./embedding-provider.js";
import { createSearchApp, type SearchApp } from "./http.js";
import { createSearchInvocationAuth } from "./invocation-auth.js";
import { createSearchKeyManagementAdapter } from "./key-management.js";
import { createPostgresSearchExecutor } from "./postgres.js";
import { createEncryptedUserSearchQuery } from "./query.js";

export type SearchComposition = Readonly<{
  app: SearchApp;
  close(): Promise<void>;
}>;

export function createSearchComposition(config: SearchConfig): SearchComposition {
  const keyManagement = createSearchKeyManagementAdapter();
  const productionInvocationAuth =
    config.invocation.kind === "trusted-source"
      ? createSearchInvocationAuth(config.invocation.source)
      : undefined;
  if (config.pipeline.kind === "disabled") {
    return Object.freeze({
      app: createSearchApp({
        config,
        keyManagement,
        ...(productionInvocationAuth === undefined ? {} : { productionInvocationAuth })
      }),
      close: () => Promise.resolve()
    });
  }
  const postgres = createPostgresSearchExecutor(config.pipeline.database);
  const repository = createEncryptedUserSearchRepository(postgres.executor);
  const query = createEncryptedUserSearchQuery({
    embeddingProvider: createOpenAISearchEmbeddingProvider({
      apiKey: config.pipeline.providerApiKey
    }),
    repository
  });
  return Object.freeze({
    app: createSearchApp({
      config,
      keyManagement,
      ...(productionInvocationAuth === undefined ? {} : { productionInvocationAuth }),
      query
    }),
    close: () => postgres.close()
  });
}
