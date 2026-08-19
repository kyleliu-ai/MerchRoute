import { describe, expect, it } from 'vitest';
import { resolveOzonSharedMediaReadiness, resolveReviewDeliveryTargets, resolveStageReviewDeliveryTargets } from './review-targets';

const target = (targetStageId: string) => ({
  targetStageId,
  targetQueueRoot: '',
  folderNameTemplate: '{sourceName}-已经审核',
  packageMode: 'preserve-relative' as const,
  copyRootMetadata: true
});

describe('审核页面投递目标', () => {
  it('按配置顺序解析别名并对多个下载来源去重', () => {
    const sources = [
      { id: 'E006', targets: [target('E001')] },
      { id: 'E007', targets: [target('E001'), target('E002')] }
    ];
    const stages = [
      { id: 'E001', alias: '生成白底图', enabled: true },
      { id: 'E002', alias: '生成五视图', enabled: true }
    ];

    expect(resolveReviewDeliveryTargets(sources, stages)).toEqual([
      { id: 'E001', alias: '生成白底图', status: 'active' },
      { id: 'E002', alias: '生成五视图', status: 'active' }
    ]);
  });

  it('保留已停用和配置缺失的目标状态', () => {
    const source = { id: 'E003', targets: [target('E004'), target('E099')] };
    const stages = [{ id: 'E004', alias: '生成视频', enabled: false }];

    expect(resolveStageReviewDeliveryTargets(source, stages)).toEqual([
      { id: 'E004', alias: '生成视频', status: 'disabled' },
      { id: 'E099', alias: '目标配置缺失', status: 'missing' }
    ]);
  });

  it('E004 和 E005 同级展示 WB 与 OZON 终端目录', () => {
    for (const id of ['E004', 'E005']) {
      expect(resolveStageReviewDeliveryTargets({ id, targets: [] }, [])).toEqual([
        { id: 'WB_SHARED_MEDIA', alias: 'WB上品目录', status: 'terminal' },
        { id: 'OZON_SHARED_MEDIA', alias: 'OZON上品目录', status: 'terminal' }
      ]);
    }
  });

  it('店铺凭据和视频上传未预检时仍允许投递到本地 OZON 共享媒体目录', () => {
    expect(resolveOzonSharedMediaReadiness({
      mediaReady: true,
      databaseReady: true,
      rootReady: true,
      credentialReady: false,
      videoUploadReady: false,
      mediaIssues: []
    })).toEqual({ ready: true });
  });
});
