// Vercel function shim: the handler comes from the esbuild bundle produced by `pnpm build`.
import { handleSearchRequest } from "../dist/entrypoint.js";

export default {
  /** @param {Request} request */
  fetch(request) {
    return handleSearchRequest(request);
  }
};
