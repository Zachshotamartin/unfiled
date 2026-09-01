import {
  SearchNotesRequestSchema,
  SearchNotesResponseSchema,
  type SearchNotesRequest,
  type SearchNotesResponse
} from "@unfiled/contracts";

import { productRequest } from "./client";

const PRIVATE_SEARCH_ENDPOINT = "/api/v1/search";

export async function requestSearchPage(
  input: SearchNotesRequest,
  signal?: AbortSignal
): Promise<SearchNotesResponse> {
  const body = SearchNotesRequestSchema.parse(input);
  const value = await productRequest<unknown>(PRIVATE_SEARCH_ENDPOINT, {
    body: JSON.stringify(body),
    cache: "no-store",
    method: "POST",
    ...(signal === undefined ? {} : { signal })
  });
  return SearchNotesResponseSchema.parse(value);
}
