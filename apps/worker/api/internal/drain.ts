import { handleWorkerRequest } from "../../src/entrypoint";

export default {
  fetch(request: Request): Promise<Response> {
    return handleWorkerRequest(request);
  }
};
