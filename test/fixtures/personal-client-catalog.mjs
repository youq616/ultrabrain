/** Fixed expected personal proxy surface; independent of production allowlists.
 * Shared by SDK-double unit tests and real installed/proxy integration tests.
 * Keep exact membership checks: a larger count is not permission to expose tools.
 */
export const EXPECTED_PERSONAL_READ_TOOLS=Object.freeze([
  'ultra_identity','ultra_personal_context','ultra_memory_read','ultra_memory_profile',
  'ultra_memory_search','ultra_agent_list','ultra_personal_jobs',
  'ultra_personal_document_list','ultra_personal_document_read',
  'ultra_personal_overview',
]);
export const EXPECTED_PERSONAL_CAPTURE_TOOLS=Object.freeze([
  ...EXPECTED_PERSONAL_READ_TOOLS,'ultra_agent_register','ultra_memory_commit',
  'ultra_personal_capture','ultra_personal_review','ultra_personal_update','ultra_personal_cancel',
]);
