import { handleVerifierRequest } from "../src/entrypoint.js";

export default {
  fetch(request: Request): Promise<Response> {
    return handleVerifierRequest(request);
  }
};
