import { handleVerifierRequest } from "../../dist/entrypoint.js";

export default {
  fetch(request: Request): Promise<Response> {
    return handleVerifierRequest(request);
  }
};
