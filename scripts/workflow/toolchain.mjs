import { stat } from 'node:fs/promises';
import path from 'node:path';
export async function npmForNode(nodePath) {
  for(const candidate of [path.join(path.dirname(nodePath),'node_modules/npm/bin/npm-cli.js'),path.resolve(path.dirname(nodePath),'../lib/node_modules/npm/bin/npm-cli.js')]){
    try{if((await stat(candidate)).isFile())return candidate;}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  throw new Error('Pinned npm CLI was not found beside the registered Node installation');
}
