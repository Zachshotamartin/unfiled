/**
 * Cross-service generation-capacity contract.
 *
 * Web must defer generations above this exact note count. The verifier keeps
 * both pagination factors fixed so Production environment drift cannot lower
 * the capacity after web has admitted a generation.
 */
export const RAG_VERIFICATION_PAGE_LIMIT = 50 as const;
export const RAG_VERIFICATION_PAGE_CIPHERTEXT_BYTE_BUDGET = 8_388_608 as const;
export const RAG_VERIFICATION_MAX_PAGES = 33 as const;
export const RAG_VERIFICATION_DATABASE_CONNECTION_ATTEMPTS = 2 as const;
