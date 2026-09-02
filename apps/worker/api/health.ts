import { handleWorkerRequest } from "../dist/entrypoint.js";

export default {
  fetch(request: Request): Promise<Response> {
    return handleWorkerRequest(request);
  }
};
