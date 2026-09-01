import { handleWorkerRequest } from "../../src/entrypoint.js";

export default {
  fetch(request: Request): Promise<Response> {
    return handleWorkerRequest(request);
  }
};
