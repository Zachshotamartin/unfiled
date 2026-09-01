import { handleOrganizerRequest } from "../src/entrypoint.js";
export default {
  fetch(request: Request): Promise<Response> {
    return handleOrganizerRequest(request);
  }
};
