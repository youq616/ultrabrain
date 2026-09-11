import {readFileSync} from 'node:fs';
import {compareRetrievalReports} from '../src/evaluation-gate.mjs';
try {
  if(process.argv.length!==4) throw new Error('Usage: bun scripts/compare-evals.mjs baseline.json candidate.json');
  const report=compareRetrievalReports(...process.argv.slice(2).map(p=>JSON.parse(readFileSync(p,'utf8'))));
  console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
} catch(e) {console.error(e.code??'invalid_evaluation');process.exitCode=1;}
