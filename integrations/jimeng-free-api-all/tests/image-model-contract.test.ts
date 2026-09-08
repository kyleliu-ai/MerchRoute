import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getSupportedImageModels } from '../src/lib/configs/model-config.ts';
import { ImageModelError, resolveImageModel, validateImageRequest, validateImageBatch, RESOLUTION_OPTIONS } from '../src/api/services/image-model.ts';
import { buildImageCompositionRequest } from '../src/api/services/image-composition-request.ts';
import modelsRoute from '../src/api/routes/models.ts';

const golden = JSON.parse(readFileSync(new URL('./fixtures/rc2-composition-request-hashes.json', import.meta.url), 'utf8'));
test('model listing exposes the same 4.7 limits without removing legacy image/video aliases',async()=>{
  const {data}=await modelsRoute.get['/models']();
  const modern=data.find((m)=>m.id==='jimeng-4.7') as any;
  assert.deepEqual(modern.capabilities.operations,['composition']);
  assert.deepEqual(modern.capabilities.resolutions,['2k']);
  assert.equal(modern.capabilities.nativeOutputCount,4);
  assert.equal(modern.completionPolicy.targetImageCount,4);
  for(const id of ['jimeng',...getSupportedImageModels(),'jimeng-video-3.0','seedance-2.0'])assert.ok(data.some(m=>m.id===id));
});
for (const c of golden.cases) {
  test(`rc.2 full serialized composition: ${c.profile}/${c.model ?? 'omitted'}/${c.count}/${c.strength}`, () => {
    let serial = 0;
    const result = buildImageCompositionRequest({
      profile: c.profile, model: c.omittedModel ? undefined : c.model,
      uploadedImageIds: Array.from({ length: c.count }, (_, i) => `fixture-upload-${i}`),
      prompt: 'fixture prompt', ratio: '3:4', resolution: '2k', sampleStrength: c.strength,
      intelligentRatio: false, assistantId: 513695,
      remoteSubmitId: c.profile === 'async' ? 'fixture-remote-submit' : undefined,
    }, { uuid: () => `fixture-uuid-${++serial}`, now: () => 1700000000000 });
    assert.equal(createHash('sha256').update(JSON.stringify(result.data)).digest('hex'), c.sha256);
    assert.equal(result.params, undefined, 'legacy request params must not inherit 4.7 overrides');
  });
}

test('unknown, blank, null, wrong-type and prototype model names fail closed', () => {
  for (const model of ['', ' ', null, 47, {}, [], 'not-a-model', 'constructor', '__proto__', 'jimeng-video-3.5-pro']) {
    assert.throws(() => resolveImageModel(model), (error: any) => error instanceof ImageModelError && error.code === 'unsupported_image_model');
  }
  assert.equal(resolveImageModel().name, 'jimeng-4.5');
  assert.equal(resolveImageModel('jimeng').name, 'jimeng-4.5');
  assert.equal(getSupportedImageModels().filter((name) => name.startsWith('jimeng-video')).length, 0);
  for (const model of ['jimeng-5.0','jimeng-4.6','jimeng-4.5','jimeng-4.1','jimeng-4.0','jimeng-3.1','jimeng-3.0','jimeng-2.1','jimeng-2.0-pro','jimeng-2.0','jimeng-1.4','jimeng-xl-pro']) {
    assert.ok(resolveImageModel(model).config.internalModel);
  }
});

test('4.7 permits only 2K reference-image operations and known ratios', () => {
  for (const ratio of Object.keys(RESOLUTION_OPTIONS['2k'])) {
    assert.equal(validateImageRequest({ model:'jimeng-4.7', operation:'composition', imageCount:1, ratio }).resolutionType, '2k');
  }
  for (const resolution of ['1k','4k','constructor',null,47]) {
    assert.throws(() => validateImageRequest({ model:'jimeng-4.7', operation:'composition', imageCount:1, resolution }), { code:'unsupported_model_resolution' });
  }
  for (const ratio of ['',null,'constructor','5:7']) {
    assert.throws(() => validateImageRequest({ model:'jimeng-4.7', operation:'composition', imageCount:1, ratio }), { code:'unsupported_model_resolution' });
  }
  assert.throws(() => validateImageRequest({ model:'jimeng-4.7', operation:'generation' }), { code:'unsupported_model_operation' });
  assert.throws(() => validateImageRequest({ model:'jimeng-4.7', operation:'composition', imageCount:0 }), { code:'unsupported_model_operation' });
});

test('batch model validation does not mutate inputs or hide invalid explicit overrides', () => {
  const task = { model:null, prompt:'fixture' };
  const common = { model:'jimeng-4.5', ratio:'3:4' };
  assert.throws(() => validateImageBatch([task], common, 1), { code:'unsupported_image_model' });
  assert.deepEqual(task, { model:null, prompt:'fixture' });
  validateImageBatch([{}], common, 1);
  assert.deepEqual(common, { model:'jimeng-4.5', ratio:'3:4' });
});

function normalizeIds(value: any, ids = new Map<string,string>()): any {
  if (Array.isArray(value)) return value.map((entry) => normalizeIds(entry, ids));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === 'id' || key === 'main_component_id') {
      if (!ids.has(String(entry))) ids.set(String(entry), `fixture-id-${ids.size}`);
      return [key, ids.get(String(entry))];
    }
    return [key, normalizeIds(entry, ids)];
  }));
}

test('4.7 candidate changes only native gen_count from the single-image website fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/jimeng47-website-sanitized.json', import.meta.url), 'utf8'));
  fixture.draft.component_list[0].abilities.gen_option.gen_count = 4;
  for (const profile of ['sync','async'] as const) {
    let serial = 0;
    const actual = buildImageCompositionRequest({
      model:'jimeng-4.7', prompt:'fixture prompt', uploadedImageIds:['fixture-upload'],
      ratio:'1:1', resolution:'2k', sampleStrength:0.5, intelligentRatio:false, assistantId:513695, profile,
    }, { uuid:() => `id-${++serial}`, now:() => 0 });
    assert.deepEqual(normalizeIds(JSON.parse(actual.data.draft_content)), normalizeIds(fixture.draft));
    assert.deepEqual(actual.params, fixture.params);
    assert.equal(actual.data.extend.root_model, 'high_aes_general_v43');
    const metrics = JSON.parse(actual.data.metrics_extra);
    assert.equal(metrics.position, 'page_bottom_box');
    assert.equal(metrics.generateCount, 1);
    assert.equal(metrics.sceneOptions, undefined);
  }
});
