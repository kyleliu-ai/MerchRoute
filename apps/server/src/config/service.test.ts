import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultConfig, workflowParameterFileName, workflowParameterOptionsFileName } from '@n8n-media-review/shared';
import { ConfigService, parseOzonMediaOutputRootTemplate, parseWbMediaOutputRootTemplate, resolveOzonMediaOutputRoot, resolveWbMediaOutputRoot } from './service.js';

describe.sequential('ConfigService v003 migration and WB directory settings', () => {
  let root = '';

  afterEach(async () => {
    delete process.env.APP_DATA_DIR;
    delete process.env.MERCHROUTE_DATA_ROOT;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('creates a fresh E007 configuration and parameter file under the deployment data root', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'workflow-config-fresh-e007-'));
    const appData = path.join(root, 'app-data');
    const dataRoot = path.join(root, 'business-media');
    process.env.APP_DATA_DIR = appData;
    process.env.MERCHROUTE_DATA_ROOT = dataRoot;

    const service = new ConfigService();
    await service.initialize();

    expect(service.get().stages.map((stage) => stage.id)).toEqual(['E006', 'E007', 'E001', 'E002', 'E003', 'E004', 'E005']);
    expect(service.get().stages.find((stage) => stage.id === 'E007')).toMatchObject({
      displayName: '1688产品媒体下载',
      workflowName: 'E007-v01-1688产品媒体下载',
      candidateRoot: path.join(dataRoot, '03-1688ProductMedia'),
      download: {
        webhookUrl: 'http://localhost:5678/webhook/1688-product-media-download',
        isDefault: false,
        recoveryMode: 'IDEMPOTENT_REPLAY'
      }
    });
    expect(JSON.parse(await readFile(path.join(appData, workflowParameterFileName('E007')), 'utf8'))).toEqual({
      SKU: '',
      productName: '',
      productUrl: '',
      parentOutputDir: path.join(dataRoot, '03-1688ProductMedia'),
      maxImagesPerTask: '4'
    });
  });

  it('backs up v001, preserves user values and imports E007 exactly once', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'workflow-config-migration-'));
    const appData = path.join(root, 'app-data');
    await mkdir(appData, { recursive: true });
    const current = createDefaultConfig('other');
    const e006 = current.stages.find((stage) => stage.id === 'E006')!;
    e006.candidateRoot = path.join(root, 'e006-output');
    e006.approvedArchiveRoot = path.join(root, 'archive', 'E006-已经审核');
    e006.targets[0]!.packageMode = 'flatten';
    e006.targets[0]!.copyRootMetadata = false;
    const legacy = {
      version: 'v001', submissionConcurrency: current.submissionConcurrency, thumbnail: current.thumbnail,
      stages: current.stages.filter((stage) => stage.id !== 'E007').map(({ alias: _alias, groupId: _groupId, download: _download, ...stage }) => stage)
    };
    await writeFile(path.join(appData, 'config.json'), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
    await writeFile(path.join(appData, workflowParameterFileName('E006')), `${JSON.stringify({ SKU: 0, productName: '模板产品名不可保留', parentOutputDir: e006.candidateRoot, customField: 'preserved' }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(appData, workflowParameterOptionsFileName('E006')), `${JSON.stringify({ SKU: [0, 1], customField: ['preserved', 'backup'] }, null, 2)}\n`, 'utf8');
    process.env.APP_DATA_DIR = appData;

    const service = new ConfigService();
    await service.initialize();
    expect(service.didMigrateLegacyConfig).toBe(true);
    expect(service.get().version).toBe('v003');
    expect(service.get().wbPublishing).toEqual({ enabled: false, rootDirectory: '' });
    expect(service.get().workflowGroups).toEqual(expect.arrayContaining([{ id: 'downloads', name: '下载组' }]));
    expect(service.get().stages.find((stage) => stage.id === 'E006')?.targets[0]).toMatchObject({ packageMode: 'flatten', copyRootMetadata: false });
    expect((await readdir(path.join(appData, 'backups'))).some((name) => name.endsWith('before-v003-migration'))).toBe(true);
    expect(JSON.parse(await readFile(path.join(appData, workflowParameterFileName('E006')), 'utf8'))).toEqual({ SKU: '', productName: '', parentOutputDir: e006.candidateRoot, customField: 'preserved' });
    expect(JSON.parse(await readFile(path.join(appData, workflowParameterOptionsFileName('E006')), 'utf8'))).toEqual({ customField: ['preserved', 'backup'] });

    const e007Output = path.join(root, 'e007-output');
    await service.mergeLegacyDownloadWorkflows([
      { code: 'E006', displayName: '拼多多产品图下载', webhookUrl: 'http://localhost:5678/webhook/pdd-image-download', parentOutputDir: e006.candidateRoot!, timeoutMs: 900000, enabled: true, isDefault: true },
      { code: 'E007', displayName: '1688产品图下载', webhookUrl: 'http://localhost:5678/webhook/1688-product-media-download', parentOutputDir: e007Output, timeoutMs: 900000, enabled: true, isDefault: false }
    ]);
    const migrated = service.get().stages.find((stage) => stage.id === 'E007');
    expect(migrated).toMatchObject({ alias: '1688下载', groupId: 'downloads', displayName: '1688产品图下载', candidateRoot: e007Output, enabled: true, download: { recoveryMode: 'IDEMPOTENT_REPLAY' }, targets: [{ targetStageId: 'E001', packageMode: 'flatten', copyRootMetadata: false }] });
    expect(JSON.parse(await readFile(path.join(appData, workflowParameterFileName('E007')), 'utf8'))).toEqual({ SKU: '', productName: '', parentOutputDir: e007Output, customField: 'preserved' });

    const backupsBeforeRestart = await readdir(path.join(appData, 'backups'));
    expect(backupsBeforeRestart.some((name) => name.endsWith('before-runtime-product-parameters'))).toBe(true);

    const restarted = new ConfigService();
    await restarted.initialize();
    expect(restarted.didMigrateLegacyConfig).toBe(false);
    await restarted.mergeLegacyDownloadWorkflows([{ code: 'E007', displayName: '不应覆盖', webhookUrl: 'http://localhost:5678/webhook/changed', parentOutputDir: 'changed', timeoutMs: 5000, enabled: false, isDefault: false }]);
    expect(restarted.get().stages.filter((stage) => stage.id === 'E007')).toHaveLength(1);
    expect(restarted.get().stages.find((stage) => stage.id === 'E007')?.displayName).toBe('1688产品图下载');
    expect(await readdir(path.join(appData, 'backups'))).toHaveLength(backupsBeforeRestart.length);
  });

  it('backs up and migrates v002 without inventing a WB drive path', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'workflow-config-v002-'));
    const appData = path.join(root, 'app-data');
    await mkdir(appData, { recursive: true });
    const current = createDefaultConfig('other');
    const v002: Record<string, unknown> = { ...current, version: 'v002', submissionConcurrency: 3 };
    delete v002.wbPublishing;
    await writeFile(path.join(appData, 'config.json'), `${JSON.stringify(v002, null, 2)}\n`, 'utf8');
    process.env.APP_DATA_DIR = appData;

    const service = new ConfigService();
    await service.initialize();

    expect(service.didMigratePreviousConfig).toBe(true);
    expect(service.get()).toMatchObject({ version: 'v003', submissionConcurrency: 3, wbPublishing: { enabled: false, rootDirectory: '' } });
    const backupDirectories = await readdir(path.join(appData, 'backups'));
    const migrationBackup = backupDirectories.find((name) => name.endsWith('before-v003-migration'));
    expect(migrationBackup).toBeDefined();
    const backedUp = JSON.parse(await readFile(path.join(appData, 'backups', migrationBackup!, 'config.json'), 'utf8'));
    expect(backedUp.version).toBe('v002');

    await service.save(service.get());
    await service.save(service.get());
    const saveBackups = (await readdir(path.join(appData, 'backups'))).filter((name) => name.endsWith('before-save'));
    expect(saveBackups).toHaveLength(2);
  });

  it('permanently removes deprecated outputRoot fields while preserving routing and WB settings', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'workflow-config-output-root-cleanup-'));
    const appData = path.join(root, 'app-data');
    await mkdir(appData, { recursive: true });
    const current = createDefaultConfig('other');
    const deprecatedStageIds = ['E001', 'E002', 'E003', 'E006', 'E007'];
    for (const stage of current.stages.filter((item) => deprecatedStageIds.includes(item.id))) {
      stage.outputRoot = stage.id === 'E001' ? '' : `/obsolete/${stage.id}`;
    }
    const wbTemplate = 'G:\\01_MerchRoute\\WB-Auto-Publish\\inbox\\<SKU>\\variants';
    current.stages.find((stage) => stage.id === 'E004')!.outputRoot = wbTemplate;
    current.stages.find((stage) => stage.id === 'E005')!.outputRoot = wbTemplate;
    current.wbPublishing.rootDirectory = 'G:\\01_MerchRoute\\WB-Auto-Publish';
    const routingSnapshot = Object.fromEntries(current.stages.map((stage) => [stage.id, {
      candidateRoot: stage.candidateRoot,
      targetQueueRoots: stage.targets.map((target) => target.targetQueueRoot)
    }]));
    await writeFile(path.join(appData, 'config.json'), `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    process.env.APP_DATA_DIR = appData;

    const service = new ConfigService();
    await service.initialize();
    const migrated = service.get();
    for (const stageId of deprecatedStageIds) {
      expect(Object.prototype.hasOwnProperty.call(migrated.stages.find((stage) => stage.id === stageId), 'outputRoot')).toBe(false);
    }
    expect(Object.fromEntries(migrated.stages.map((stage) => [stage.id, {
      candidateRoot: stage.candidateRoot,
      targetQueueRoots: stage.targets.map((target) => target.targetQueueRoot)
    }]))).toEqual(routingSnapshot);
    expect(migrated.stages.find((stage) => stage.id === 'E004')?.outputRoot).toBe(wbTemplate);
    expect(migrated.stages.find((stage) => stage.id === 'E005')?.outputRoot).toBe(wbTemplate);
    expect(migrated.wbPublishing.rootDirectory).toBe('G:\\01_MerchRoute\\WB-Auto-Publish');

    const backupDirectories = await readdir(path.join(appData, 'backups'));
    const cleanupBackup = backupDirectories.find((name) => name.endsWith('before-nonterminal-output-root-cleanup'));
    expect(cleanupBackup).toBeDefined();
    const backedUp = JSON.parse(await readFile(path.join(appData, 'backups', cleanupBackup!, 'config.json'), 'utf8'));
    expect(backedUp.stages.find((stage: { id: string }) => stage.id === 'E002').outputRoot).toBe('/obsolete/E002');
    const persisted = JSON.parse(await readFile(path.join(appData, 'config.json'), 'utf8'));
    expect(Object.prototype.hasOwnProperty.call(persisted.stages.find((stage: { id: string }) => stage.id === 'E002'), 'outputRoot')).toBe(false);

    const backupsBeforeRestart = await readdir(path.join(appData, 'backups'));
    const restarted = new ConfigService();
    await restarted.initialize();
    expect(await readdir(path.join(appData, 'backups'))).toHaveLength(backupsBeforeRestart.length);

    const imported = restarted.get();
    for (const stage of imported.stages.filter((item) => deprecatedStageIds.includes(item.id))) stage.outputRoot = `C:\\legacy\\${stage.id}`;
    await restarted.save(imported);
    for (const stageId of deprecatedStageIds) {
      expect(Object.prototype.hasOwnProperty.call(restarted.get().stages.find((stage) => stage.id === stageId), 'outputRoot')).toBe(false);
    }
    const saved = JSON.parse(await readFile(path.join(appData, 'config.json'), 'utf8'));
    expect(saved.stages.filter((stage: { id: string }) => deprecatedStageIds.includes(stage.id)).every((stage: object) => !Object.prototype.hasOwnProperty.call(stage, 'outputRoot'))).toBe(true);
  });

  it('backs up before parameter migration and leaves the original file untouched when migration fails', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'workflow-runtime-parameter-failure-'));
    const appData = path.join(root, 'app-data');
    await mkdir(appData, { recursive: true });
    await writeFile(path.join(appData, 'config.json'), `${JSON.stringify(createDefaultConfig('other'), null, 2)}\n`, 'utf8');
    const invalid = '{ "SKU": 0, invalid-json';
    await writeFile(path.join(appData, workflowParameterFileName('E006')), invalid, 'utf8');
    process.env.APP_DATA_DIR = appData;

    const service = new ConfigService();
    await expect(service.initialize()).rejects.toBeTruthy();
    expect(await readFile(path.join(appData, workflowParameterFileName('E006')), 'utf8')).toBe(invalid);
    const backups = await readdir(path.join(appData, 'backups'));
    const migrationBackup = backups.find((name) => name.endsWith('before-runtime-product-parameters'))!;
    expect(await readFile(path.join(appData, 'backups', migrationBackup, workflowParameterFileName('E006')), 'utf8')).toBe(invalid);
  });

  it('validates and initializes the configured WB root without a hard-coded default', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'workflow-config-wb-root-'));
    const appData = path.join(root, 'app-data');
    process.env.APP_DATA_DIR = appData;
    const service = new ConfigService();
    await service.initialize();
    const wbRoot = path.join(root, 'wb-publishing');

    const validation = await service.initializeWbPublishingDirectory(wbRoot);
    expect(validation).toMatchObject({ path: wbRoot, exists: true, readable: true, writable: true });
    expect(validation.directories).toEqual(expect.arrayContaining([
      path.join(wbRoot, 'inbox'), path.join(wbRoot, 'processing'), path.join(wbRoot, 'success'),
      path.join(wbRoot, 'failed'), path.join(wbRoot, '.locks'), path.join(wbRoot, 'errors')
    ]));
    await service.saveWbPublishing({ enabled: true, rootDirectory: wbRoot });
    expect(service.get().wbPublishing).toEqual({ enabled: true, rootDirectory: wbRoot });
    await expect(service.initializeWbPublishingDirectory('.')).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(service.initializeWbPublishingDirectory(path.parse(wbRoot).root)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('migrates only the legacy SKU path segment and links E004/E005 to one WB root', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'workflow-config-wb-template-'));
    const appData = path.join(root, 'app-data');
    await mkdir(appData, { recursive: true });
    const current = createDefaultConfig('other');
    const legacyTemplate = 'G:\\01_MerchRoute\\WB-Auto-Publish\\inbox\\SKU\\variants';
    current.stages.find((stage) => stage.id === 'E004')!.outputRoot = legacyTemplate;
    current.stages.find((stage) => stage.id === 'E005')!.outputRoot = legacyTemplate;
    await writeFile(path.join(appData, 'config.json'), `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    process.env.APP_DATA_DIR = appData;
    const service = new ConfigService();
    await service.initialize();
    const expected = 'G:\\01_MerchRoute\\WB-Auto-Publish\\inbox\\<SKU>\\variants';
    expect(service.get().stages.find((stage) => stage.id === 'E004')?.outputRoot).toBe(expected);
    expect(service.get().stages.find((stage) => stage.id === 'E005')?.outputRoot).toBe(expected);
    expect(service.get().wbPublishing.rootDirectory).toBe('G:\\01_MerchRoute\\WB-Auto-Publish');
    expect((await readdir(path.join(appData, 'backups'))).some((name) => name.endsWith('before-wb-media-output-template'))).toBe(true);
    expect(resolveWbMediaOutputRoot(expected, '0000011')).toBe('G:\\01_MerchRoute\\WB-Auto-Publish\\inbox\\0000011\\variants');
    expect(() => parseWbMediaOutputRootTemplate('G:\\root\\inbox\\<SKU>\\variants\\extra')).toThrow(/结尾/);
    expect(() => parseWbMediaOutputRootTemplate('G:\\root\\inbox\\<SKU>\\<VARIANT>\\variants')).toThrow(/未知占位符/);
  });

  it('adds and links the OZON media template without changing WB settings', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'workflow-config-ozon-template-'));
    const appData = path.join(root, 'app-data');
    await mkdir(appData, { recursive: true });
    const current = createDefaultConfig('other');
    const wbTemplate = 'G:\\01_MerchRoute\\WB-Auto-Publish\\inbox\\<SKU>\\variants';
    current.stages.find((stage) => stage.id === 'E004')!.outputRoot = wbTemplate;
    current.stages.find((stage) => stage.id === 'E005')!.outputRoot = wbTemplate;
    current.wbPublishing.rootDirectory = 'G:\\01_MerchRoute\\WB-Auto-Publish';
    delete current.stages.find((stage) => stage.id === 'E004')!.ozonOutputRoot;
    delete current.stages.find((stage) => stage.id === 'E005')!.ozonOutputRoot;
    await writeFile(path.join(appData, 'config.json'), `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    process.env.APP_DATA_DIR = appData;

    const service = new ConfigService();
    await service.initialize();

    const expected = process.platform === 'win32'
      ? 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\<SKU>\\variants'
      : '/Volumes/YOUR_DATA_DISK/01_MerchRoute/OZON-Auto-Publish/inbox/<SKU>/variants';
    expect(service.get().stages.find((stage) => stage.id === 'E004')?.ozonOutputRoot).toBe(expected);
    expect(service.get().stages.find((stage) => stage.id === 'E005')?.ozonOutputRoot).toBe(expected);
    expect(service.get().wbPublishing).toEqual({ enabled: false, rootDirectory: 'G:\\01_MerchRoute\\WB-Auto-Publish' });
    expect((await readdir(path.join(appData, 'backups'))).some((name) => name.endsWith('before-ozon-media-output-template'))).toBe(true);
    expect(resolveOzonMediaOutputRoot(expected, '0000011')).toContain('OZON-Auto-Publish');
    expect(() => parseOzonMediaOutputRootTemplate('G:\\root\\inbox\\<SKU>\\variants\\extra')).toThrow(/结尾/);
  });
});
