import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {createImageCompletionPolicy} from '../src/api/services/image-completion-policy.mjs';
import {imageCompletionPolicy as policy} from '../src/api/services/image-completion-policy.mjs';
import {getSupportedImageModels} from '../src/lib/configs/model-config.ts';
import {imageCompositionOutputCount} from '../src/api/services/image-model.ts';

for(const model of ['jimeng',...getSupportedImageModels()]) {
  test(`${model}: shared 0-4 image, uncertainty and retry contract`,()=>{
    assert.equal(imageCompositionOutputCount(model),4);
    for(let count=0;count<=5;count++) {
      const imageUrls=Array.from({length:count},(_,i)=>`https://fixture.invalid/${i}.png`);
      const complete=policy.evaluate({rawStatus:50,imageUrls});
      assert.equal(complete.state,count?'success':'processing');
      assert.equal(complete.count,Math.min(4,count));
      assert.equal(complete.partial,count>0&&count<4);
      const deadline=policy.evaluate({rawStatus:20,imageUrls,deadlineReached:true});
      assert.equal(deadline.state,count?'success':'processing');
      assert.equal(deadline.canRetry,false);
    }
    assert.equal(policy.evaluate({status:'failed'}).canRetry,true);
    assert.equal(policy.evaluate({status:'failed',retryAttempt:1}).canRetry,false);
    for(const status of ['reserved','submission_unknown','processing']) assert.equal(policy.evaluate({status,deadlineReached:true}).canRetry,false);
    for(const failCode of ['2038','401','403','unsupported_model_operation',-2000,-2002,-2003,-2004,-2006,-2009]) assert.equal(policy.evaluate({status:'failed',failCode}).canRetry,false);
    assert.equal(policy.evaluate({rawStatus:30,failCode:'2038',imageUrls:['https://fixture.invalid/a.png']}).count,0);
  });
}
test('reference images, signatures and CDN size variants cannot inflate count',()=>{
  const result=policy.evaluate({rawStatus:50,referenceImages:['https://fixture.invalid/input.png?a=1'],imageUrls:[
    'https://fixture.invalid/input.png?a=2','https://fixture.invalid/a.png~tplv-small?sign=1',
    'https://fixture.invalid/a.png~tplv-large?sign=2','', 'placeholder', 'https://fixture.invalid/b.png']});
  assert.equal(result.count,2);
});
test('embedded n8n policy also validates URLs without a global URL constructor',()=>{
  const sandboxPolicy=vm.runInNewContext(`(${createImageCompletionPolicy.toString()})()`);
  const result=sandboxPolicy.evaluate({rawStatus:50,referenceImages:['https://fixture.invalid/input.png'],imageUrls:[
    'https://fixture.invalid/input.png~small?sign=1','https://fixture.invalid/a.png?sign=1','https://fixture.invalid/a.png?sign=2','invalid']});
  assert.equal(result.count,1);assert.equal(result.partial,true);
});
test('workflow windows are model-independent, stable and bounded',()=>{
  for(const [profile,attempt,ms] of [['E001',0,60000],['E001',1,120000],['S003',0,300000],['S003',1,300000]] as const){
    assert.equal(policy.timing(profile,attempt,1000,1000+ms-1).waitMs,1);
    assert.equal(policy.timing(profile,attempt,1000,1000+ms).deadlineReached,true);
  }
  assert.equal(policy.timing('E002',0,1000,9999999,119).deadlineReached,false);
  assert.equal(policy.timing('E002',1,1000,9999999,120).deadlineReached,true);
  assert.throws(()=>policy.timing('E001',2,0,0));
});
