import type { StageConfig } from '@n8n-media-review/shared';

type TargetSourceStage = Pick<StageConfig, 'id' | 'targets'>;
type TargetStage = Pick<StageConfig, 'id' | 'alias' | 'enabled'>;

export type ReviewDeliveryTarget = {
  id?: string;
  alias: string;
  status: 'active' | 'disabled' | 'missing' | 'terminal';
};

type OzonMediaReadiness = {
  mediaReady?: boolean;
  databaseReady: boolean;
  rootReady: boolean;
  credentialReady?: boolean;
  videoUploadReady?: boolean;
  mediaIssues?: string[];
};

const WB_MEDIA_TERMINAL_STAGE_IDS = new Set(['E004', 'E005']);

export function isWbMediaTerminalStage(stage?: Pick<StageConfig, 'id'>): boolean {
  return Boolean(stage && WB_MEDIA_TERMINAL_STAGE_IDS.has(stage.id));
}

export function resolveOzonSharedMediaReadiness(readiness?: OzonMediaReadiness): { ready: boolean; reason?: string } {
  if (!readiness) return { ready: false, reason: 'OZON 共享媒体目录状态不可用' };
  const ready = readiness.mediaReady ?? Boolean(readiness.databaseReady && readiness.rootReady);
  return ready
    ? { ready: true }
    : { ready: false, reason: readiness.mediaIssues?.join('；') || 'OZON 共享媒体目录尚未就绪' };
}

export function resolveReviewDeliveryTargets(
  sourceStages: readonly TargetSourceStage[],
  allStages: readonly TargetStage[]
): ReviewDeliveryTarget[] {
  const stagesById = new Map(allStages.map((stage) => [stage.id, stage]));
  const seenTargetIds = new Set<string>();
  const targets: ReviewDeliveryTarget[] = [];

  for (const sourceStage of sourceStages) {
    for (const target of sourceStage.targets) {
      if (seenTargetIds.has(target.targetStageId)) continue;
      seenTargetIds.add(target.targetStageId);
      const targetStage = stagesById.get(target.targetStageId);
      targets.push(targetStage
        ? { id: targetStage.id, alias: targetStage.alias, status: targetStage.enabled ? 'active' : 'disabled' }
        : { id: target.targetStageId, alias: '目标配置缺失', status: 'missing' });
    }
  }

  return targets;
}

export function resolveStageReviewDeliveryTargets(
  stage: TargetSourceStage,
  allStages: readonly TargetStage[]
): ReviewDeliveryTarget[] {
  if (isWbMediaTerminalStage(stage)) return [
    { id: 'WB_SHARED_MEDIA', alias: 'WB上品目录', status: 'terminal' },
    { id: 'OZON_SHARED_MEDIA', alias: 'OZON上品目录', status: 'terminal' }
  ];
  return resolveReviewDeliveryTargets([stage], allStages);
}
