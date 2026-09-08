import { validateImageRequest } from './image-model.ts';

export function buildImageCompositionRequest(input: {
  model?: unknown; prompt: string; uploadedImageIds: string[];
  ratio?: string; resolution?: string; sampleStrength?: number; intelligentRatio?: boolean;
  assistantId: number; profile: 'sync' | 'async'; remoteSubmitId?: string;
}, clock: { uuid: () => string; now: () => number }) {
  const { config, width, height, imageRatio, resolutionType } = validateImageRequest({
    ...input, operation: 'composition', imageCount: input.uploadedImageIds.length,
  });
  const modern = config.imagePolicy?.compositionProtocol === 'seedream-20260908';
  const model = config.internalModel;
  const { uploadedImageIds, prompt, assistantId, profile } = input;
  const sampleStrength = input.sampleStrength ?? 0.5;
  const intelligentRatio = input.intelligentRatio ?? false;
  const componentId = clock.uuid();
  const submitId = input.remoteSubmitId || clock.uuid();
  // Preserve the legacy metrics (and UUID evaluation order) for rc.2 models.
  const sceneOption = modern ? undefined : {
    type: 'image', scene: 'ImageBasicGenerate', modelReqKey: input.model, resolutionType,
    abilityList: uploadedImageIds.map(() => ({
      abilityName: 'byte_edit', strength: sampleStrength,
      source: { imageUrl: `blob:https://jimeng.jianying.com/${clock.uuid()}` },
    })),
    reportParams: {
      enterSource: 'generate', vipSource: 'generate',
      extraVipFunctionKey: `${input.model}-${resolutionType}`,
      useVipFunctionDetailsReporterHoc: true,
    },
  };
  const metrics = modern ? {
    promptSource: 'custom', generateCount: 1, enterFrom: 'click',
    position: 'page_bottom_box', isBoxSelect: false, isCutout: false,
    hasRejectedAudit: 0, generateId: submitId, isRegenerate: false,
  } : {
    promptSource: 'custom', generateCount: 1, enterFrom: 'click',
    sceneOptions: JSON.stringify([sceneOption]), generateId: submitId, isRegenerate: false,
  };
  const draft = {
    type: 'draft', id: clock.uuid(), min_version: modern ? '3.0.2' : '3.2.9',
    min_features: [], is_from_tsn: true, version: modern ? config.draftVersion : '3.2.9',
    main_component_id: componentId,
    component_list: [{
      type: 'image_base_component', id: componentId, min_version: '3.0.2',
      ...(!modern && profile === 'async' ? { min_features: [] } : {}),
      aigc_mode: 'workbench',
      metadata: {
        type: '', id: clock.uuid(), created_platform: 3, created_platform_version: '',
        created_time_in_ms: clock.now().toString(), created_did: '',
      },
      generate_type: 'blend',
      abilities: {
        type: '', id: clock.uuid(),
        blend: {
          type: '', id: clock.uuid(), ...(!modern ? { min_version: '3.2.9' } : {}), min_features: [],
          core_param: {
            type: '', id: clock.uuid(), model, prompt: `${'#'.repeat(uploadedImageIds.length * 2)}${prompt}`,
            sample_strength: sampleStrength, image_ratio: imageRatio,
            large_image_info: { type: '', id: clock.uuid(), height, width, resolution_type: resolutionType },
            intelligent_ratio: intelligentRatio, ...(modern ? { generate_type: 0 } : {}),
          },
          ability_list: uploadedImageIds.map((imageId) => ({
            type: '', id: clock.uuid(), name: 'byte_edit', image_uri_list: [imageId],
            image_list: [{
              type: 'image', id: clock.uuid(), source_from: 'upload', platform_type: 1, name: '',
              image_uri: imageId, width: 0, height: 0, format: '', uri: imageId,
            }],
            // rc.2 sync uses fixed 0.5 here, while async uses sampleStrength.
            strength: !modern && profile === 'sync' ? 0.5 : sampleStrength,
          })),
          prompt_placeholder_info_list: uploadedImageIds.map((_, index) => ({
            type: '', id: clock.uuid(), ability_index: index,
          })),
          postedit_param: { type: '', id: clock.uuid(), generate_type: 0 },
        },
        ...(modern ? { gen_option: { type: '', id: clock.uuid(), gen_count: config.imagePolicy!.nativeOutputCount, generate_all: false } } : {}),
      },
    }],
  };
  return {
    ...(modern ? { params: { ...config.imagePolicy!.requestParams } } : {}),
    data: {
      extend: { root_model: model }, submit_id: submitId,
      metrics_extra: JSON.stringify(metrics), draft_content: JSON.stringify(draft),
      http_common_info: { aid: assistantId },
    },
  };
}
