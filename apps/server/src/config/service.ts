import os from 'node:os';
import path from 'node:path';
import { access, copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import writeFileAtomic from 'write-file-atomic';
import {
  APP_VERSION,
  appConfigSchema,
  createDefaultConfig,
  createDefaultWorkflowParameters,
  DEPRECATED_OUTPUT_ROOT_STAGE_IDS,
  legacyAppConfigSchema,
  previousAppConfigSchema,
  WORKFLOW_RUNTIME_PARAMETER_NAMES,
  withWorkflowRuntimeParameterPlaceholders,
  workflowUsesVariantParameter,
  workflowParameterFileName,
  workflowParameterOptionsFileName,
  type AppConfig,
  type WbPublishingConfig,
  type StageConfig,
  type WorkflowGroup,
  type WorkflowParameterOptions,
  type WorkflowParameterJsonValue,
  type WorkflowParameterValue,
  type WorkflowParameters,
  AppError
} from '@n8n-media-review/shared';

export const getAppDataDir = (): string => {
  if (process.env.APP_DATA_DIR) return path.resolve(process.env.APP_DATA_DIR);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'n8n-media-review-center');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'n8n-media-review-center');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'n8n-media-review-center');
};

export type PathValidation = {
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  freeBytes?: number;
  checkedAt: string;
  error?: string;
};

export class ConfigService {
  readonly appDataDir = getAppDataDir();
  readonly configFile = path.join(this.appDataDir, 'config.json');
  private config?: AppConfig;
  didMigrateLegacyConfig = false;
  didMigratePreviousConfig = false;

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.appDataDir, { recursive: true }),
      mkdir(path.join(this.appDataDir, 'logs'), { recursive: true }),
      mkdir(path.join(this.appDataDir, 'thumbnails'), { recursive: true }),
      mkdir(path.join(this.appDataDir, 'temp'), { recursive: true })
    ]);
    try {
      const raw = await readFile(this.configFile, 'utf8');
      const input = JSON.parse(raw);
      const current = appConfigSchema.safeParse(input);
      if (current.success) this.config = current.data;
      else {
        const previous = previousAppConfigSchema.safeParse(input);
        if (previous.success) {
          await this.backupConfigFiles('before-v003-migration');
          this.config = migratePreviousConfig(previous.data);
          await this.writeConfig(this.config);
          this.didMigratePreviousConfig = true;
        } else {
          const legacy = legacyAppConfigSchema.safeParse(input);
          if (!legacy.success) throw new AppError('CONFIG_INVALID', '现有配置格式无效，已停止启动以避免覆盖', { issues: current.error.issues });
          await this.backupConfigFiles('before-v003-migration');
          this.config = migrateLegacyConfig(legacy.data);
          await this.writeConfig(this.config);
          this.didMigrateLegacyConfig = true;
        }
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'other';
      const dataRoot = process.env.MERCHROUTE_DATA_ROOT?.trim();
      if (dataRoot && !path.isAbsolute(dataRoot)) throw new AppError('CONFIG_INVALID', 'MERCHROUTE_DATA_ROOT 必须是绝对路径', { variable: 'MERCHROUTE_DATA_ROOT' });
      this.config = createDefaultConfig(platform, dataRoot);
      await this.writeConfig(this.config);
    }
    await this.migrateDeprecatedOutputRoots();
    await this.initializeWorkflowParameterFiles();
    await this.migrateWorkflowRuntimeParameters();
    await this.migrateWbMediaOutputTemplate();
    await this.migrateOzonMediaOutputTemplate();
  }

  get(): AppConfig {
    if (!this.config) throw new Error('ConfigService has not been initialized');
    return structuredClone(this.config);
  }

  async save(input: unknown): Promise<AppConfig> {
    const parsed = appConfigSchema.safeParse(input);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', '配置格式无效', { issues: parsed.error.issues });
    await mkdir(this.appDataDir, { recursive: true });
    await this.backupConfigFiles('before-save', false);
    const linked = linkOzonMediaOutputConfig(linkWbMediaOutputConfig(parsed.data));
    if (linked.wbPublishing.enabled && linked.wbPublishing.rootDirectory) await this.initializeWbPublishingDirectory(linked.wbPublishing.rootDirectory);
    await this.writeConfig(linked);
    this.config = linked;
    await this.initializeWorkflowParameterFiles();
    await this.migrateWorkflowRuntimeParameters();
    return this.get();
  }

  async createWorkflow(stageInput: unknown, copyFromStageId?: string): Promise<AppConfig> {
    const current = this.get();
    const stage = stageInput as StageConfig;
    if (current.stages.some((item) => item.id === stage?.id)) throw new AppError('CONFIG_INVALID', `工作流 ${stage?.id || ''} 已存在`, { stageId: stage?.id }, 409);
    const next = parseAppConfig({ ...current, stages: [...current.stages, stage] });
    const sourceParameters = copyFromStageId ? await this.getWorkflowParameterTemplate(copyFromStageId) : { parameters: withWorkflowRuntimeParameterPlaceholders({}, workflowUsesVariantParameter(stage.id)), parameterOptions: {} };
    await this.backupConfigFiles('before-create-workflow');
    await atomicWriteWithRetry(path.join(this.appDataDir, workflowParameterFileName(stage.id)), `${JSON.stringify(withWorkflowRuntimeParameterPlaceholders(sourceParameters.parameters, workflowUsesVariantParameter(stage.id)), null, 2)}\n`);
    await atomicWriteWithRetry(path.join(this.appDataDir, workflowParameterOptionsFileName(stage.id)), `${JSON.stringify(removeRuntimeParameterOptions(sourceParameters.parameterOptions), null, 2)}\n`);
    try {
      await this.writeConfig(next);
      this.config = next;
      return this.get();
    } catch (error) {
      await Promise.all([
        rm(path.join(this.appDataDir, workflowParameterFileName(stage.id)), { force: true }),
        rm(path.join(this.appDataDir, workflowParameterOptionsFileName(stage.id)), { force: true })
      ]);
      throw error;
    }
  }

  async updateWorkflow(stageId: string, stageInput: unknown): Promise<AppConfig> {
    const current = this.get();
    const index = current.stages.findIndex((stage) => stage.id === stageId);
    if (index < 0) throw new AppError('CONFIG_INVALID', '未知的工作流阶段', { stageId }, 404);
    if ((stageInput as StageConfig)?.id !== stageId) throw new AppError('CONFIG_INVALID', '工作流编号创建后不能修改', { stageId }, 409);
    const stages = structuredClone(current.stages);
    stages[index] = stageInput as StageConfig;
    return this.save({ ...current, stages });
  }

  async saveWorkflowGroups(groupsInput: unknown, assignmentsInput: unknown): Promise<AppConfig> {
    const current = this.get();
    const groups = groupsInput as WorkflowGroup[];
    const assignments = assignmentsInput as Record<string, string>;
    const stages = current.stages.map((stage) => ({ ...stage, groupId: assignments?.[stage.id] || stage.groupId }));
    return this.save({ ...current, workflowGroups: groups, stages });
  }

  async deleteWorkflow(stageId: string): Promise<AppConfig> {
    const current = this.get();
    if (!current.stages.some((stage) => stage.id === stageId)) throw new AppError('CONFIG_INVALID', '未知的工作流阶段', { stageId }, 404);
    const next = parseAppConfig({ ...current, stages: current.stages.filter((stage) => stage.id !== stageId) });
    await this.backupConfigFiles('before-delete-workflow');
    await this.archiveWorkflowParameterFiles(stageId);
    try {
      await this.writeConfig(next);
      this.config = next;
      return this.get();
    } catch (error) {
      await this.restoreLatestArchivedWorkflowFiles(stageId);
      throw error;
    }
  }

  async archiveWorkflowParameterFiles(stageId: string): Promise<string | undefined> {
    const files = [workflowParameterFileName(stageId), workflowParameterOptionsFileName(stageId)];
    const existing = [] as string[];
    for (const file of files) if (await stat(path.join(this.appDataDir, file)).catch(() => null)) existing.push(file);
    if (!existing.length) return undefined;
    const directory = path.join(this.appDataDir, 'workflow-archive', `${stageId}-${timestampSlug()}`);
    await mkdir(directory, { recursive: true });
    for (const file of existing) await rename(path.join(this.appDataDir, file), path.join(directory, file));
    return directory;
  }

  async mergeLegacyDownloadWorkflows(workflows: Array<{ code: string; displayName: string; webhookUrl: string; parentOutputDir: string; timeoutMs: number; enabled: boolean; isDefault: boolean; recoveryMode?: 'MANUAL' | 'IDEMPOTENT_REPLAY' }>): Promise<AppConfig> {
    if (!this.didMigrateLegacyConfig || !workflows.length) return this.get();
    const current = this.get();
    const stages = structuredClone(current.stages);
    const e006 = stages.find((stage) => stage.id === 'E006');
    for (const workflow of workflows) {
      const recoveryMode = ['E006', 'E007'].includes(workflow.code) ? 'IDEMPOTENT_REPLAY' as const : workflow.recoveryMode || 'MANUAL';
      const existing = stages.find((stage) => stage.id === workflow.code);
      if (existing) {
        existing.download = { webhookUrl: workflow.webhookUrl, timeoutMs: workflow.timeoutMs, isDefault: workflow.isDefault, recoveryMode };
        existing.enabled = workflow.enabled;
        if (workflow.parentOutputDir) existing.candidateRoot = workflow.parentOutputDir;
        continue;
      }
      if (workflow.code !== 'E007' || !e006) continue;
      const archiveParent = e006.approvedArchiveRoot ? path.dirname(e006.approvedArchiveRoot) : path.dirname(workflow.parentOutputDir);
      const stage: StageConfig = {
        ...structuredClone(e006),
        id: 'E007', alias: '1688下载', groupId: 'downloads', displayName: workflow.displayName,
        workflowName: 'E007-1688产品图下载', description: '下载 1688 产品主图和详情图', enabled: workflow.enabled,
        candidateRoot: workflow.parentOutputDir,
        approvedArchiveRoot: path.join(archiveParent, 'E007-已经审核'),
        download: { webhookUrl: workflow.webhookUrl, timeoutMs: workflow.timeoutMs, isDefault: workflow.isDefault, recoveryMode }
      };
      stages.splice(Math.max(0, stages.findIndex((item) => item.id === 'E006') + 1), 0, stage);
      const sourceTemplate = await this.getWorkflowParameterTemplate('E006');
      const parameters = structuredClone(sourceTemplate.parameters);
      if ('parentOutputDir' in parameters) parameters.parentOutputDir = workflow.parentOutputDir;
      await atomicWriteWithRetry(path.join(this.appDataDir, workflowParameterFileName('E007')), `${JSON.stringify(parameters, null, 2)}\n`);
      await atomicWriteWithRetry(path.join(this.appDataDir, workflowParameterOptionsFileName('E007')), `${JSON.stringify(sourceTemplate.parameterOptions, null, 2)}\n`);
    }
    return this.save({ ...current, stages });
  }

  workflowParameterFile(stageId: string): string {
    this.assertStage(stageId);
    return path.join(this.appDataDir, workflowParameterFileName(stageId));
  }

  workflowParameterOptionsFile(stageId: string): string {
    this.assertStage(stageId);
    return path.join(this.appDataDir, workflowParameterOptionsFileName(stageId));
  }

  async getWorkflowParameters(stageId: string): Promise<WorkflowParameters> {
    const file = this.workflowParameterFile(stageId);
    try {
      return withWorkflowRuntimeParameterPlaceholders(normalizeWorkflowParameters(JSON.parse(await readFile(file, 'utf8'))), workflowUsesVariantParameter(stageId));
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        const parameters = createDefaultWorkflowParameters(this.configuredDataRoot())[stageId] || withWorkflowRuntimeParameterPlaceholders({}, workflowUsesVariantParameter(stageId));
        await atomicWriteWithRetry(file, `${JSON.stringify(parameters, null, 2)}\n`);
        return structuredClone(parameters);
      }
      if (error instanceof AppError) throw error;
      throw new AppError('CONFIG_INVALID', `工作流 ${stageId} 参数模板无法读取`, { file, reason: error?.message });
    }
  }

  async getWorkflowParameterOptions(stageId: string, parameters?: WorkflowParameters): Promise<WorkflowParameterOptions> {
    const file = this.workflowParameterOptionsFile(stageId);
    const currentParameters = parameters || await this.getWorkflowParameters(stageId);
    try {
      return normalizeWorkflowParameterOptions(removeRuntimeParameterOptions(JSON.parse(await readFile(file, 'utf8'))), currentParameters, true);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        await atomicWriteWithRetry(file, '{}\n');
        return {};
      }
      if (error instanceof AppError) throw error;
      throw new AppError('CONFIG_INVALID', `工作流 ${stageId} 参数选项无法读取`, { file, reason: error?.message });
    }
  }

  async getWorkflowParameterTemplate(stageId: string): Promise<{ parameters: WorkflowParameters; parameterOptions: WorkflowParameterOptions }> {
    const parameters = await this.getWorkflowParameters(stageId);
    const parameterOptions = await this.getWorkflowParameterOptions(stageId, parameters);
    return { parameters, parameterOptions };
  }

  async saveWorkflowParameterTemplate(stageId: string, parameterInput: unknown, optionInput: unknown = {}): Promise<{ parameters: WorkflowParameters; parameterOptions: WorkflowParameterOptions }> {
    const parameters = withWorkflowRuntimeParameterPlaceholders(this.validateWorkflowParameters(parameterInput), workflowUsesVariantParameter(stageId));
    const parameterOptions = normalizeWorkflowParameterOptions(removeRuntimeParameterOptions(optionInput), parameters, true);
    const parameterFile = this.workflowParameterFile(stageId);
    const optionsFile = this.workflowParameterOptionsFile(stageId);
    const previousParameters = await readFile(parameterFile, 'utf8').catch(() => undefined);
    await atomicWriteWithRetry(parameterFile, `${JSON.stringify(parameters, null, 2)}\n`);
    try {
      await atomicWriteWithRetry(optionsFile, `${JSON.stringify(parameterOptions, null, 2)}\n`);
    } catch (error) {
      if (previousParameters !== undefined) await atomicWriteWithRetry(parameterFile, previousParameters);
      throw error;
    }
    return { parameters: structuredClone(parameters), parameterOptions: structuredClone(parameterOptions) };
  }

  async saveWorkflowParameters(stageId: string, input: unknown): Promise<WorkflowParameters> {
    return (await this.saveWorkflowParameterTemplate(stageId, input, {})).parameters;
  }

  validateWorkflowParameters(input: unknown): WorkflowParameters {
    return normalizeWorkflowParameters(input);
  }

  validateWorkflowParameterSelection(parameterInput: unknown, optionInput: unknown): { parameters: WorkflowParameters; parameterOptions: WorkflowParameterOptions } {
    const parameters = withWorkflowRuntimeParameterPlaceholders(normalizeWorkflowParameters(parameterInput));
    const parameterOptions = normalizeWorkflowParameterOptions(removeRuntimeParameterOptions(optionInput), parameters, false);
    for (const [fieldName, options] of Object.entries(parameterOptions)) {
      if (!options.some((option) => Object.is(option, parameters[fieldName]))) {
        throw new AppError('CONFIG_INVALID', '任务参数值必须来自冻结的下拉选项', { fieldName });
      }
    }
    return { parameters, parameterOptions };
  }

  private async initializeWorkflowParameterFiles(): Promise<void> {
    const defaults = createDefaultWorkflowParameters(this.configuredDataRoot());
    for (const stage of this.get().stages) {
      const file = this.workflowParameterFile(stage.id);
      if (!await stat(file).catch(() => null)) {
        const parameters = structuredClone(defaults[stage.id] || withWorkflowRuntimeParameterPlaceholders({}, workflowUsesVariantParameter(stage.id)));
        if (stage.download && stage.candidateRoot && 'parentOutputDir' in parameters) parameters.parentOutputDir = stage.candidateRoot;
        await atomicWriteWithRetry(file, `${JSON.stringify(parameters, null, 2)}\n`);
      }
      const optionsFile = this.workflowParameterOptionsFile(stage.id);
      if (!await stat(optionsFile).catch(() => null)) await atomicWriteWithRetry(optionsFile, '{}\n');
    }
  }

  private configuredDataRoot(): string {
    const e001InputQueueRoot = this.get().stages.find((stage) => stage.id === 'E001')?.inputQueueRoot?.trim();
    if (e001InputQueueRoot) return path.dirname(path.dirname(e001InputQueueRoot));
    const environmentRoot = process.env.MERCHROUTE_DATA_ROOT?.trim();
    if (environmentRoot) return environmentRoot;
    return process.platform === 'win32' ? 'G:\\01_MerchRoute' : '/Volumes/YOUR_DATA_DISK/01_MerchRoute';
  }

  private async migrateWorkflowRuntimeParameters(): Promise<void> {
    const marker = path.join(this.appDataDir, '.runtime-product-parameters-v1');
    if (await stat(marker).catch(() => null)) return;
    await this.backupConfigFiles('before-runtime-product-parameters');
    const changes: Array<{ file: string; previous: string; next: string }> = [];
    for (const stage of this.get().stages) {
      const parameterFile = this.workflowParameterFile(stage.id);
      const optionsFile = this.workflowParameterOptionsFile(stage.id);
      const previousParameters = await readFile(parameterFile, 'utf8');
      const previousOptions = await readFile(optionsFile, 'utf8');
      const parameters = withWorkflowRuntimeParameterPlaceholders(normalizeWorkflowParameters(JSON.parse(previousParameters)), workflowUsesVariantParameter(stage.id));
      const options = normalizeWorkflowParameterOptions(removeRuntimeParameterOptions(JSON.parse(previousOptions)), parameters, true);
      const nextParameters = `${JSON.stringify(parameters, null, 2)}\n`;
      const nextOptions = `${JSON.stringify(options, null, 2)}\n`;
      if (previousParameters !== nextParameters) changes.push({ file: parameterFile, previous: previousParameters, next: nextParameters });
      if (previousOptions !== nextOptions) changes.push({ file: optionsFile, previous: previousOptions, next: nextOptions });
    }
    const written: typeof changes = [];
    try {
      for (const change of changes) {
        await atomicWriteWithRetry(change.file, change.next);
        written.push(change);
      }
      await atomicWriteWithRetry(marker, 'v1\n');
    } catch (error) {
      await Promise.all(written.map((change) => atomicWriteWithRetry(change.file, change.previous)));
      await rm(marker, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async migrateDeprecatedOutputRoots(): Promise<void> {
    const normalized = removeDeprecatedOutputRoots(this.get());
    if (!normalized.changed) return;
    await this.backupConfigFiles('before-nonterminal-output-root-cleanup');
    await this.writeConfig(normalized.config);
    this.config = normalized.config;
  }

  private async migrateWbMediaOutputTemplate(): Promise<void> {
    const current = this.get();
    const stages = structuredClone(current.stages);
    let changed = false;
    for (const stage of stages.filter((item) => item.id === 'E004' || item.id === 'E005')) {
      if (!stage.outputRoot) continue;
      const migrated = stage.outputRoot.replace(/([\\/])SKU(?=[\\/]variants(?:[\\/]?$))/i, '$1<SKU>');
      if (migrated !== stage.outputRoot) {
        stage.outputRoot = migrated;
        changed = true;
      }
    }
    if (!changed) return;
    const candidate = linkWbMediaOutputConfig({ ...current, stages });
    await this.backupConfigFiles('before-wb-media-output-template');
    await this.writeConfig(candidate);
    this.config = candidate;
  }

  private async migrateOzonMediaOutputTemplate(): Promise<void> {
    const current = this.get();
    const stages = structuredClone(current.stages);
    const defaultTemplate = process.platform === 'win32'
      ? 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\<SKU>\\variants'
      : '/Volumes/YOUR_DATA_DISK/01_MerchRoute/OZON-Auto-Publish/inbox/<SKU>/variants';
    let changed = false;
    for (const stage of stages.filter((item) => item.id === 'E004' || item.id === 'E005')) {
      const migrated = (stage.ozonOutputRoot || defaultTemplate).replace(/([\\/])SKU(?=[\\/]variants(?:[\\/]?$))/i, '$1<SKU>');
      if (migrated !== stage.ozonOutputRoot) {
        stage.ozonOutputRoot = migrated;
        changed = true;
      }
    }
    if (!changed) return;
    const candidate = linkOzonMediaOutputConfig({ ...current, stages });
    await this.backupConfigFiles('before-ozon-media-output-template');
    await this.writeConfig(candidate);
    this.config = candidate;
  }

  private assertStage(stageId: string): void {
    if (!this.get().stages.some((stage) => stage.id === stageId)) {
      throw new AppError('CONFIG_INVALID', '未知的工作流阶段', { stageId }, 404);
    }
  }

  private async writeConfig(config: AppConfig): Promise<void> {
    await atomicWriteWithRetry(this.configFile, `${JSON.stringify(config, null, 2)}\n`);
  }

  private async backupConfigFiles(reason: string, includeParameters = true): Promise<string | undefined> {
    if (!await stat(this.configFile).catch(() => null)) return undefined;
    const parentDirectory = path.join(this.appDataDir, 'backups');
    await mkdir(parentDirectory, { recursive: true });
    const timestamp = timestampSlug();
    let suffix = 0;
    let directory = '';
    while (!directory) {
      const candidate = path.join(parentDirectory, `${timestamp}${suffix ? `-${suffix + 1}` : ''}-${reason}`);
      try {
        await mkdir(candidate);
        directory = candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        suffix += 1;
      }
    }
    await copyFile(this.configFile, path.join(directory, 'config.json'));
    if (includeParameters) {
      const files = await readdir(this.appDataDir);
      for (const file of files.filter((name) => /^E\d{3}_n8n_product_image_task(?:\.options)?\.json$/.test(name))) {
        await copyFile(path.join(this.appDataDir, file), path.join(directory, file));
      }
    }
    return directory;
  }

  private async restoreLatestArchivedWorkflowFiles(stageId: string): Promise<void> {
    const root = path.join(this.appDataDir, 'workflow-archive');
    const directories = (await readdir(root).catch(() => [])).filter((name) => name.startsWith(`${stageId}-`)).sort().reverse();
    const latest = directories[0];
    if (!latest) return;
    for (const file of [workflowParameterFileName(stageId), workflowParameterOptionsFileName(stageId)]) {
      const archived = path.join(root, latest, file);
      if (await stat(archived).catch(() => null)) await rename(archived, path.join(this.appDataDir, file));
    }
  }

  async validatePath(targetPath: string): Promise<PathValidation> {
    const result: PathValidation = { path: targetPath, exists: false, readable: false, writable: false, checkedAt: new Date().toISOString() };
    try {
      const info = await stat(targetPath);
      result.exists = info.isDirectory();
      if (!result.exists) throw new Error('路径不是目录');
      await access(targetPath, constants.R_OK);
      result.readable = true;
      await access(targetPath, constants.W_OK);
      result.writable = true;
      if (typeof statfs === 'function') {
        const disk = await statfs(targetPath);
        result.freeBytes = Number(disk.bavail) * Number(disk.bsize);
      }
    } catch (error: any) {
      result.error = error?.message || '路径不可访问';
    }
    return result;
  }

  async createDirectory(targetPath: string): Promise<PathValidation> {
    const allowed = this.get().stages.flatMap((stage) => [stage.approvedArchiveRoot, ...stage.targets.map((target) => target.targetQueueRoot)]).filter(Boolean);
    if (!allowed.some((item) => path.resolve(item!) === path.resolve(targetPath))) {
      throw new AppError('CONFIG_INVALID', '只能创建已配置的监听目录或审核归档目录', { path: targetPath });
    }
    await mkdir(targetPath, { recursive: true });
    return this.validatePath(targetPath);
  }

  async saveWbPublishing(input: WbPublishingConfig): Promise<AppConfig> {
    const current = this.get();
    const rootDirectory = input.rootDirectory.trim();
    if (input.enabled || rootDirectory) assertValidWbRootDirectory(rootDirectory);
    const outputRoot = rootDirectory ? absolutePathFlavor(rootDirectory)!.join(rootDirectory, 'inbox', '<SKU>', 'variants') : undefined;
    const stages = current.stages.map((stage) => stage.id === 'E004' || stage.id === 'E005' ? { ...stage, outputRoot } : stage);
    return this.save({ ...current, stages, wbPublishing: { enabled: input.enabled, rootDirectory } });
  }

  async initializeWbPublishingDirectory(rootDirectory: string): Promise<PathValidation & { directories: string[] }> {
    const root = rootDirectory.trim();
    assertValidWbRootDirectory(root);
    const existing = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw new AppError('CONFIG_INVALID', 'WB 自动上品根路径必须是真实目录，不能是文件或符号链接', { rootDirectory: root });
    const directories = ['', 'inbox', 'processing', 'success', 'failed', '.locks', 'errors'].map((name) => name ? path.join(root, name) : root);
    for (const directory of directories) await mkdir(directory, { recursive: true });
    const probe = path.join(root, `.pixroute-write-probe-${process.pid}-${Date.now()}`);
    try {
      await writeFile(probe, 'ok', { flag: 'wx' });
    } finally {
      await rm(probe, { force: true }).catch(() => undefined);
    }
    const validation = await this.validatePath(root);
    if (!validation.exists || !validation.readable || !validation.writable) {
      throw new AppError('PATH_NOT_WRITABLE', 'WB 自动上品根目录不可读写', { validation });
    }
    return { ...validation, directories };
  }
}

function parseAppConfig(input: unknown): AppConfig {
  const parsed = appConfigSchema.safeParse(input);
  if (!parsed.success) throw new AppError('CONFIG_INVALID', '配置格式无效', { issues: parsed.error.issues });
  return parsed.data;
}

function migrateLegacyConfig(input: ReturnType<typeof legacyAppConfigSchema.parse>): AppConfig {
  const aliases: Record<string, string> = { E006: 'PDD下载', E001: '抠图', E002: '五视图', E003: '套图', E004: '视频', E005: 'LOGO' };
  const groupIds: Record<string, string> = { E006: 'downloads', E001: 'cutout', E002: 'generation', E003: 'generation', E004: 'video', E005: 'logo' };
  return appConfigSchema.parse({
    ...input,
    version: APP_VERSION,
    wbPublishing: { enabled: false, rootDirectory: '' },
    workflowGroups: [
      { id: 'downloads', name: '下载组' },
      { id: 'cutout', name: '抠图组' },
      { id: 'generation', name: '生图组' },
      { id: 'video', name: '视频组' },
      { id: 'logo', name: 'LOGO组' }
    ],
    stages: input.stages.map((stage) => ({
      ...stage,
      alias: aliases[stage.id] || stage.displayName,
      groupId: groupIds[stage.id] || 'generation',
      ...(stage.id === 'E006' ? { download: { webhookUrl: 'http://localhost:5678/webhook/pdd-image-download', timeoutMs: 900_000, isDefault: true, recoveryMode: 'IDEMPOTENT_REPLAY' as const } } : {})
    }))
  });
}

function migratePreviousConfig(input: ReturnType<typeof previousAppConfigSchema.parse>): AppConfig {
  return appConfigSchema.parse({
    ...input,
    version: APP_VERSION,
    wbPublishing: { enabled: false, rootDirectory: '' }
  });
}

export function assertValidWbRootDirectory(input: string): void {
  const value = String(input || '').trim();
  if (!value) throw new AppError('CONFIG_INVALID', '请填写 WB 自动上品根目录');
  if (value.includes('\0')) throw new AppError('CONFIG_INVALID', 'WB 自动上品根目录包含无效字符');
  const flavor = absolutePathFlavor(value);
  if (!flavor) throw new AppError('CONFIG_INVALID', 'WB 自动上品根目录必须是绝对路径', { rootDirectory: value });
  const normalized = flavor.normalize(value);
  if (normalized.toLocaleLowerCase() === flavor.parse(normalized).root.toLocaleLowerCase()) {
    throw new AppError('CONFIG_INVALID', '不能将磁盘或卷根目录用作 WB 自动上品根目录', { rootDirectory: value });
  }
}

export function parseWbMediaOutputRootTemplate(input: string): { template: string; rootDirectory: string; flavor: typeof path.win32 | typeof path.posix } {
  const value = String(input || '').trim();
  if (!value) throw new AppError('CONFIG_INVALID', '请填写 WB 共享媒体输出目录模板');
  if ((value.match(/<SKU>/g) || []).length !== 1) throw new AppError('CONFIG_INVALID', 'WB 共享媒体输出目录模板必须且只能包含一个 <SKU>');
  const unknown = value.match(/<[^>]+>/g)?.filter((item) => item !== '<SKU>') || [];
  if (unknown.length) throw new AppError('CONFIG_INVALID', 'WB 共享媒体输出目录模板包含未知占位符', { placeholders: unknown });
  const flavor = absolutePathFlavor(value);
  if (!flavor) throw new AppError('CONFIG_INVALID', 'WB 共享媒体输出目录模板必须是绝对路径');
  const normalized = flavor.normalize(value);
  const parts = normalized.split(flavor.sep).filter(Boolean);
  const suffix = parts.slice(-3);
  if (suffix.length !== 3 || suffix[0]?.toLocaleLowerCase() !== 'inbox' || suffix[1] !== '<SKU>' || suffix[2]?.toLocaleLowerCase() !== 'variants') {
    throw new AppError('CONFIG_INVALID', 'WB 共享媒体输出目录模板必须以 inbox/<SKU>/variants 结尾', { template: value });
  }
  const rootDirectory = flavor.dirname(flavor.dirname(flavor.dirname(normalized)));
  assertValidWbRootDirectory(rootDirectory);
  return { template: normalized, rootDirectory, flavor };
}

export function resolveWbMediaOutputRoot(template: string, sku: string): string {
  if (!/^\d{7}$/.test(sku)) throw new AppError('CONFIG_INVALID', 'SKU 必须是 7 位数字字符串', { sku });
  const parsed = parseWbMediaOutputRootTemplate(template);
  return parsed.flavor.normalize(parsed.template.replace('<SKU>', sku));
}

export function parseOzonMediaOutputRootTemplate(input: string): { template: string; rootDirectory: string; flavor: typeof path.win32 | typeof path.posix } {
  return parseMediaOutputRootTemplate(input, 'OZON');
}

export function resolveOzonMediaOutputRoot(template: string, sku: string): string {
  if (!/^\d{7}$/.test(sku)) throw new AppError('CONFIG_INVALID', 'SKU 必须是 7 位数字字符串', { sku });
  const parsed = parseOzonMediaOutputRootTemplate(template);
  return parsed.flavor.normalize(parsed.template.replace('<SKU>', sku));
}

function linkWbMediaOutputConfig(input: AppConfig): AppConfig {
  const config = removeDeprecatedOutputRoots(input).config;
  const e004 = config.stages.find((stage) => stage.id === 'E004');
  const e005 = config.stages.find((stage) => stage.id === 'E005');
  const configured = [e004?.outputRoot, e005?.outputRoot].filter((value): value is string => Boolean(value?.trim()));
  if (!configured.length) return config;
  if (!e004?.outputRoot || !e005?.outputRoot) throw new AppError('CONFIG_INVALID', 'E004 和 E005 必须同时配置 WB 共享媒体输出目录模板');
  const left = parseWbMediaOutputRootTemplate(e004.outputRoot);
  const right = parseWbMediaOutputRootTemplate(e005.outputRoot);
  if (normalizeComparablePath(left.template) !== normalizeComparablePath(right.template)) {
    throw new AppError('CONFIG_INVALID', 'E004 和 E005 必须使用完全相同的 WB 共享媒体输出目录模板');
  }
  e004.outputRoot = left.template;
  e005.outputRoot = left.template;
  config.wbPublishing.rootDirectory = left.rootDirectory;
  return config;
}

function linkOzonMediaOutputConfig(input: AppConfig): AppConfig {
  const config = structuredClone(input);
  const e004 = config.stages.find((stage) => stage.id === 'E004');
  const e005 = config.stages.find((stage) => stage.id === 'E005');
  const configured = [e004?.ozonOutputRoot, e005?.ozonOutputRoot].filter((value): value is string => Boolean(value?.trim()));
  if (!e004 && !e005) return config;
  if (!configured.length) throw new AppError('CONFIG_INVALID', 'E004 和 E005 必须配置 OZON 共享媒体输出目录模板');
  if (!e004?.ozonOutputRoot || !e005?.ozonOutputRoot) throw new AppError('CONFIG_INVALID', 'E004 和 E005 必须同时配置 OZON 共享媒体输出目录模板');
  const left = parseOzonMediaOutputRootTemplate(e004.ozonOutputRoot);
  const right = parseOzonMediaOutputRootTemplate(e005.ozonOutputRoot);
  if (normalizeComparablePath(left.template) !== normalizeComparablePath(right.template)) {
    throw new AppError('CONFIG_INVALID', 'E004 和 E005 必须使用完全相同的 OZON 共享媒体输出目录模板');
  }
  e004.ozonOutputRoot = left.template;
  e005.ozonOutputRoot = left.template;
  return config;
}

function parseMediaOutputRootTemplate(input: string, platform: 'WB' | 'OZON'): { template: string; rootDirectory: string; flavor: typeof path.win32 | typeof path.posix } {
  const value = String(input || '').trim();
  if (!value) throw new AppError('CONFIG_INVALID', `请填写 ${platform} 共享媒体输出目录模板`);
  if ((value.match(/<SKU>/g) || []).length !== 1) throw new AppError('CONFIG_INVALID', `${platform} 共享媒体输出目录模板必须且只能包含一个 <SKU>`);
  const unknown = value.match(/<[^>]+>/g)?.filter((item) => item !== '<SKU>') || [];
  if (unknown.length) throw new AppError('CONFIG_INVALID', `${platform} 共享媒体输出目录模板包含未知占位符`, { placeholders: unknown });
  const flavor = absolutePathFlavor(value);
  if (!flavor) throw new AppError('CONFIG_INVALID', `${platform} 共享媒体输出目录模板必须是绝对路径`);
  const normalized = flavor.normalize(value);
  const parts = normalized.split(flavor.sep).filter(Boolean);
  const suffix = parts.slice(-3);
  if (suffix.length !== 3 || suffix[0]?.toLocaleLowerCase() !== 'inbox' || suffix[1] !== '<SKU>' || suffix[2]?.toLocaleLowerCase() !== 'variants') {
    throw new AppError('CONFIG_INVALID', `${platform} 共享媒体输出目录模板必须以 inbox/<SKU>/variants 结尾`, { template: value });
  }
  const rootDirectory = flavor.dirname(flavor.dirname(flavor.dirname(normalized)));
  assertValidWbRootDirectory(rootDirectory);
  return { template: normalized, rootDirectory, flavor };
}

function removeDeprecatedOutputRoots(input: AppConfig): { config: AppConfig; changed: boolean } {
  const config = structuredClone(input);
  let changed = false;
  for (const stage of config.stages) {
    if (!DEPRECATED_OUTPUT_ROOT_STAGE_IDS.includes(stage.id) || !Object.prototype.hasOwnProperty.call(stage, 'outputRoot')) continue;
    delete stage.outputRoot;
    changed = true;
  }
  return { config, changed };
}

function normalizeComparablePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US');
}

function absolutePathFlavor(value: string): typeof path.win32 | typeof path.posix | undefined {
  const windowsStyle = /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\') || value.startsWith('//');
  if (windowsStyle) return path.win32.isAbsolute(value) ? path.win32 : undefined;
  return path.posix.isAbsolute(value) ? path.posix : undefined;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function normalizeWorkflowParameters(input: unknown): WorkflowParameters {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('CONFIG_INVALID', '工作流参数必须是 JSON 对象');
  }
  const normalizedEntries: Array<[string, WorkflowParameterValue]> = [];
  const names = new Set<string>();
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.trim();
    if (!name) throw new AppError('CONFIG_INVALID', '工作流参数字段名不能为空');
    if (names.has(name)) {
      throw new AppError('CONFIG_INVALID', '工作流参数字段名不能重复', { fieldName: name });
    }
    names.add(name);
    normalizedEntries.push([name, normalizeWorkflowParameterValue(value, name)]);
  }
  return Object.fromEntries(normalizedEntries);
}

function normalizeWorkflowParameterOptions(input: unknown, parameters: WorkflowParameters, requireFirstDefault: boolean): WorkflowParameterOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('CONFIG_INVALID', '工作流参数选项必须是 JSON 对象');
  }
  const normalized: WorkflowParameterOptions = {};
  for (const [rawName, rawOptions] of Object.entries(input)) {
    const fieldName = rawName.trim();
    if (!fieldName || !(fieldName in parameters)) {
      throw new AppError('CONFIG_INVALID', '参数选项必须对应已有字段', { fieldName });
    }
    const parameterValue = parameters[fieldName];
    const expectedType = typeof parameterValue;
    if (expectedType !== 'string' && expectedType !== 'number') {
      throw new AppError('CONFIG_INVALID', '只有 String 和 Number 字段支持下拉选项', { fieldName });
    }
    if (!Array.isArray(rawOptions) || rawOptions.length < 2) {
      throw new AppError('CONFIG_INVALID', '下拉字段至少需要两个选项', { fieldName });
    }
    const options = rawOptions.map((rawOption) => {
      if (expectedType === 'string') {
        if (typeof rawOption !== 'string' || !rawOption.trim()) {
          throw new AppError('CONFIG_INVALID', 'String 选项不能为空', { fieldName });
        }
        return rawOption.trim();
      }
      if (typeof rawOption !== 'number' || !Number.isFinite(rawOption)) {
        throw new AppError('CONFIG_INVALID', 'Number 选项必须是有限数字', { fieldName });
      }
      return rawOption;
    });
    const uniqueKeys = new Set(options.map((option) => `${typeof option}:${String(option)}`));
    if (uniqueKeys.size !== options.length) {
      throw new AppError('CONFIG_INVALID', '下拉选项不能重复', { fieldName });
    }
    if (requireFirstDefault && !Object.is(options[0], parameterValue)) {
      throw new AppError('CONFIG_INVALID', '第一个下拉选项必须是字段默认值', { fieldName });
    }
    normalized[fieldName] = options;
  }
  return normalized;
}

function removeRuntimeParameterOptions(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([name]) => !WORKFLOW_RUNTIME_PARAMETER_NAMES.includes(name as (typeof WORKFLOW_RUNTIME_PARAMETER_NAMES)[number])));
}

function normalizeWorkflowParameterValue(value: unknown, fieldName: string): WorkflowParameterValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AppError('CONFIG_INVALID', '工作流参数数字必须是有限值', { fieldName });
    }
    return value;
  }
  if (Array.isArray(value)) {
    validateJsonArray(value, fieldName);
    return structuredClone(value) as WorkflowParameterJsonValue[];
  }
  throw new AppError('CONFIG_INVALID', '工作流参数值仅支持字符串、数字、布尔值或数组', { fieldName });
}

function validateJsonArray(value: unknown[], fieldName: string): void {
  const visit = (item: unknown): item is WorkflowParameterJsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (Array.isArray(item)) return item.every(visit);
    if (typeof item === 'object') return Object.values(item as Record<string, unknown>).every(visit);
    return false;
  };
  if (!value.every(visit)) {
    throw new AppError('CONFIG_INVALID', '工作流参数数组必须是有效 JSON 数组', { fieldName });
  }
}

async function statfs(targetPath: string): Promise<{ bavail: bigint | number; bsize: bigint | number }> {
  const fs = await import('node:fs/promises');
  return fs.statfs(targetPath);
}

async function atomicWriteWithRetry(file: string, content: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await writeFileAtomic(file, content, { encoding: 'utf8' });
      return;
    } catch (error: any) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}
