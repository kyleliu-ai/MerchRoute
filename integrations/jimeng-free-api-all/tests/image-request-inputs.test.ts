import assert from 'node:assert/strict';
import test from 'node:test';
import { multipartImageFiles } from '../src/api/services/image-request-inputs.ts';

test('multipart images follow normalized Request.filesMap, not its flat files array',()=>{
  const file={filepath:'/isolated/fixture.png'};
  assert.deepEqual(multipartImageFiles({filesMap:{images:[file]},rawFiles:{images:file},files:[file]}),[file]);
  assert.equal(multipartImageFiles({rawFiles:{images:file},files:[file]}),file);
  assert.equal(multipartImageFiles({files:{images:file}}),file);
  assert.equal(multipartImageFiles({filesMap:{other:[file]},files:[file]}),undefined);
  assert.deepEqual(multipartImageFiles({filesMap:{images:[]},rawFiles:{images:file}}),[]);
});
