// Vercel function shim: the handler comes from the esbuild bundle produced by `pnpm build`.
import { handleOrganizerRequest } from "../dist/entrypoint.js";

export default {
  /** @param {Request} request */
  fetch(request) {
    return handleOrganizerRequest(request);
  }
};
