import {requireThat, sha256, text} from './core.mjs';

export const PERSONAL_MEMORY_TYPES = Object.freeze([
  'identity','preference','environment','project','decision','skill','error','goal','experience'
]);

export function normalizePersonalMemory(input={}) {
  requireThat(input && typeof input==='object' && !Array.isArray(input),'invalid_params','Memory object required');
  requireThat(PERSONAL_MEMORY_TYPES.includes(input.type),'invalid_params','Unknown personal memory type');
  text(input.content,'content',65536);
  const confidence=input.confidence ?? 0.5;
  requireThat(Number.isFinite(confidence)&&confidence>=0&&confidence<=1,'invalid_params','Invalid confidence');
  return Object.freeze({
    id:input.id ?? null,
    type:input.type,
    content:input.content,
    confidence,
    importance:input.importance ?? 'normal',
    source:input.source ?? 'agent',
    agent_id:input.agent_id ?? null,
    project_id:input.project_id ?? null,
    status:input.status ?? 'candidate',
    content_hash:sha256(input.content)
  });
}

export function classifyMemory(value) {
  const s=String(value).toLowerCase();
  if(/prefer|喜欢|习惯|always|通常/.test(s)) return 'preference';
  if(/ubuntu|windows|docker|environment|环境/.test(s)) return 'environment';
  if(/decision|决定|采用|选择/.test(s)) return 'decision';
  if(/error|错误|failed|失败|解决/.test(s)) return 'error';
  if(/project|项目|version|版本/.test(s)) return 'project';
  return 'experience';
}
