import { handleOrganizerRequest } from "../../dist/entrypoint.js";
export default {
  fetch(request: Request): Promise<Response> {
    return handleOrganizerRequest(request);
  }
};
