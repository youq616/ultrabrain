/** Extract only a completed n8n execution envelope from captured CLI logs.
 * No log text, node inputs or credentials are returned by parsing errors.
 */
export function executionFromOutput(output) {
  if (typeof output !== 'string') throw new Error('No execution envelope');
  let start=-1,depth=0,quoted=false,escaped=false;
  for (let i=0;i<output.length;i++) {
    const c=output[i];
    if(start<0) {if(c==='{'){start=i;depth=1;}continue;}
    if(quoted) {
      if(escaped)escaped=false;
      else if(c==='\\')escaped=true;
      else if(c==='"')quoted=false;
      continue;
    }
    if(c==='"'){quoted=true;continue;}
    if(c==='{')depth++;
    else if(c==='}'&&--depth===0) {
      try {
        const value=JSON.parse(output.slice(start,i+1));
        if(value?.data?.resultData && typeof value.data.resultData==='object')return value;
      }catch{}
      start=-1;quoted=false;escaped=false;
    }
  }
  throw new Error('No execution envelope');
}
