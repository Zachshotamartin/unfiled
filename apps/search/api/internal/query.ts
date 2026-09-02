import { handleSearchRequest } from "../../src/entrypoint.js";

export default {
  fetch(request: Request): Promise<Response> {
    return handleSearchRequest(request);
  }
};
