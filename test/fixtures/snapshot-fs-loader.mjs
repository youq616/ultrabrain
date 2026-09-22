/** Fault hooks for the production reader only; all operations still use real fs. */
export async function resolve(specifier,context,next) {
  if (specifier === 'node:fs/promises' && context.parentURL?.endsWith('/src/client-snapshot-files.mjs'))
    return {url:new URL('./snapshot-fs-hook.mjs',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}
