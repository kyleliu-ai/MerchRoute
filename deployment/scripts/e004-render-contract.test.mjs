import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { materializeWorkflow } from '../n8n/portable-workflow.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const n8nRoot = path.join(projectRoot, 'deployment', 'n8n');
const sourceRoot = path.join(n8nRoot, 'sources');
const workflowRoot = path.join(n8nRoot, 'workflows', 'core');
const require = createRequire(import.meta.url);

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const readWorkflow = (id) => readJson(path.join(workflowRoot, `${id}.json`));
const requireNode = (workflow, name) => {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `${workflow.id} 缺少节点 ${name}`);
  return node;
};

function embeddedSource(code, constantName) {
  const match = code.match(new RegExp(`const ${constantName} = '([^']+)';`));
  assert.ok(match, `缺少 ${constantName}`);
  return gunzipSync(Buffer.from(match[1], 'base64')).toString('utf8');
}

async function createPackageFixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-e004-contract-'));
  const groupOne = path.join(root, '第1组');
  const groupTwo = path.join(root, '第2组', '细分');
  await mkdir(groupOne, { recursive: true });
  await mkdir(groupTwo, { recursive: true });
  const files = [
    { relative: '第1组/01.png', content: Buffer.from('nested-image-one') },
    { relative: '第2组/细分/02.jpg', content: Buffer.from('nested-image-two') },
  ];
  for (const file of files) await writeFile(path.join(root, ...file.relative.split('/')), file.content);
  if (options.extraImage) await writeFile(path.join(groupTwo, 'extra.png'), 'extra');
  if (options.temporaryFile) await writeFile(path.join(groupTwo, 'download.part'), 'partial');
  const parameterFileName = 'n8n_setParameter_E004_fixture.json';
  const config = {
    SKU: '0000001',
    productName: 'E004 契约测试',
    variants: '红色',
    maxWaitSeconds: 2,
    waitStableSeconds: 1,
    allowedImageExtensions: ['.png', '.jpg'],
  };
  const manifest = {
    schemaVersion: '1.0',
    taskId: 'task-e004-fixture',
    sourceStageId: 'E003',
    targetStageId: 'E004',
    selectedImageCount: files.length,
    selectedFiles: files.map((file, index) => ({ sortOrder: index, targetRelativePath: file.relative, sizeBytes: file.content.length })),
    n8nParameterFileName: parameterFileName,
    productSku: config.SKU,
    productName: config.productName,
    variantName: config.variants,
  };
  const submissionId = 'SUB-E004-FIXTURE';
  await writeFile(path.join(root, parameterFileName), JSON.stringify(config));
  await writeFile(path.join(root, 'selection-manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'task-context.json'), JSON.stringify({ schemaVersion: 1, workflowCode: 'E004', SKU: config.SKU, productName: config.productName, variants: config.variants, sourceSubmissionId: submissionId }));
  await writeFile(path.join(root, '_READY.json'), JSON.stringify({ ready: true, submissionId, taskId: manifest.taskId, sourceStageId: manifest.sourceStageId, targetStageId: 'E004', imageCount: files.length, n8nParameterFileName: parameterFileName }));
  return { root, files };
}

async function runWaitFixture(fixture) {
  const source = await readFile(path.join(sourceRoot, 'e004-wait-stable.cjs.txt'), 'utf8');
  const runner = path.join(fixture.root, '..', `${path.basename(fixture.root)}-runner.cjs`);
  await writeFile(runner, source);
  const payload = Buffer.from(JSON.stringify({ folder: fixture.root, defaultMaxWaitSeconds: 2, intervalMs: 200 })).toString('base64');
  const result = spawnSync(process.execPath, [runner, payload], { encoding: 'utf8', timeout: 5000 });
  await rm(runner, { force: true });
  return result;
}

test('E004/S015 workflow gzip constants exactly match the reviewable sources', async () => {
  const e004 = await readWorkflow('noHJuIiHfHryuA2e');
  const s015 = await readWorkflow('x8D4EHfqI2DHcgL7');
  assert.equal(e004.name, 'E004-v01-主图生视频-FFmpeg');
  assert.equal(embeddedSource(requireNode(e004, 'Normalize Trigger Path').parameters.jsCode, 'E004_WAIT_STABLE_SCRIPT_GZIP_BASE64'), await readFile(path.join(sourceRoot, 'e004-wait-stable.cjs.txt'), 'utf8'));
  assert.equal(embeddedSource(requireNode(s015, 'Build FFmpeg Command').parameters.jsCode, 'S015_RENDER_SCRIPT_GZIP_BASE64'), await readFile(path.join(sourceRoot, 's015-render.cjs.txt'), 'utf8'));
  assert.equal(requireNode(e004, 'Parse Stable Result').parameters.jsCode, (await readFile(path.join(sourceRoot, 'e004-parse-stable.js.txt'), 'utf8')).trimEnd());
  assert.equal(requireNode(e004, 'Collect Image Files').parameters.jsCode, (await readFile(path.join(sourceRoot, 'e004-collect-images.js.txt'), 'utf8')).trimEnd());
  assert.equal(requireNode(e004, 'Prepare Job Json').parameters.jsCode, (await readFile(path.join(sourceRoot, 'e004-prepare-job.js.txt'), 'utf8')).trimEnd());
  assert.equal(requireNode(e004, 'Build Final Result').parameters.jsCode, (await readFile(path.join(sourceRoot, 'e004-build-final.js.txt'), 'utf8')).trimEnd());
  assert.equal(requireNode(s015, 'Load Preset Config').parameters.jsCode, (await readFile(path.join(sourceRoot, 's015-load-preset.js.txt'), 'utf8')).trimEnd());
  assert.equal(requireNode(s015, 'Build Render Result').parameters.jsCode, (await readFile(path.join(sourceRoot, 's015-build-result.js.txt'), 'utf8')).trimEnd());
});

test('E004 stable package runner accepts exactly registered nested images', async (context) => {
  const fixture = await createPackageFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const result = await runWaitFixture(fixture);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.stable, true);
  assert.equal(summary.imageCount, 2);
  assert.ok(summary.imageFiles.every((file) => file.includes('第')));
  assert.match(summary.contentSha256, /^[a-f0-9]{64}$/);
});

test('E004 stable package runner rejects an unregistered nested image immediately', async (context) => {
  const fixture = await createPackageFixture({ extraImage: true });
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const result = await runWaitFixture(fixture);
  assert.equal(result.status, 2, result.stderr);
  const summary = JSON.parse(result.stderr.trim());
  assert.equal(summary.error, 'unregistered_images_present');
  assert.equal(summary.transient, false);
});

test('E004 stable package runner recursively observes unfinished downloads', async (context) => {
  const fixture = await createPackageFixture({ temporaryFile: true });
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const result = await runWaitFixture(fixture);
  assert.equal(result.status, 3, result.stderr);
  const summary = JSON.parse(result.stderr.trim());
  assert.equal(summary.error, 'package_not_ready_before_timeout');
  assert.equal(summary.details.reason, 'temporary_files_present');
});

test('S015 strict preset contract preserves explicit zero values and rejects invalid dimensions', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-s015-contract-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const outputParent = path.join(root, 'output');
  const outputSubDir = path.join(outputParent, 'job');
  await mkdir(source, { recursive: true });
  await mkdir(outputSubDir, { recursive: true });
  const image = path.join(source, '01.png');
  const ffmpeg = path.join(root, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  await writeFile(image, 'image');
  await writeFile(ffmpeg, 'fixture');
  const code = await readFile(path.join(sourceRoot, 's015-load-preset.js.txt'), 'utf8');
  const execute = new Function('require', '$input', code);
  const base = {
    imagePaths: [image],
    sourceChildDir: source,
    outputSubDir,
    outputVideoPath: path.join(outputSubDir, 'result.mp4'),
    effectPreset: 'case1',
    params: {
      outputParentDir: outputParent,
      ffmpegPath: ffmpeg,
      maxImageCount: 10,
      enableLogo: false,
      logoPosition: 'top_left',
      transitionDuration: 0,
      audioVolume: 0,
      audioFadeIn: 0,
      audioFadeOut: 0,
      width: 720,
      height: 720,
      fps: 30,
      targetDuration: 10,
    },
  };
  const [result] = execute(require, { first: () => ({ json: base }) });
  assert.equal(result.json.preset.transitionDuration, 0);
  assert.equal(result.json.preset.audio.volume, 0);
  assert.equal(result.json.preset.audio.fadeIn, 0);
  assert.equal(result.json.preset.audio.fadeOut, 0);
  assert.equal(result.json.preset.audio.enabled, false);
  assert.throws(() => execute(require, { first: () => ({ json: { ...base, params: { ...base.params, width: 721 } } }) }), /必须是偶数/);
});

test('E004/S015 reject ambiguous success, expose ffprobe verification, and declare inactive new installs', async () => {
  const e004 = await readWorkflow('noHJuIiHfHryuA2e');
  const s015 = await readWorkflow('x8D4EHfqI2DHcgL7');
  const finalCode = requireNode(e004, 'Build Final Result').parameters.jsCode;
  const buildCode = requireNode(s015, 'Build FFmpeg Command').parameters.jsCode;
  assert.doesNotMatch(finalCode, /success\s*===\s*true\s*\|\|/);
  assert.match(finalCode, /render\.success !== true \|\| render\.ok !== true/);
  assert.match(buildCode, /ffprobePath/);
  assert.match(buildCode, /partialOutputPath/);
  assert.match(buildCode, /renderInvocation/);
  assert.doesNotMatch(requireNode(s015, 'Build Render Result').parameters.jsCode, /videoOnlyPath|ffmpegCommand|ffmpegStderr/);
  const manifest = await readJson(path.join(n8nRoot, 'manifest.json'));
  assert.equal(manifest.newInstallActivationPolicy, 'inactive');
  const importer = await readFile(path.join(n8nRoot, 'scripts', 'import-workflows.mjs'), 'utf8');
  assert.match(importer, /newInstallActivationPolicy !== 'inactive'/);
  assert.match(importer, /--activeState=false/);
});

test('S015 renders a synthetic video through the real FFmpeg and FFprobe chain when available', async (context) => {
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['ffmpeg'], { encoding: 'utf8' });
  const ffmpegPath = String(lookup.stdout || '').split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  if (lookup.status !== 0 || !ffmpegPath) return context.skip('本机 PATH 中没有 FFmpeg');
  const temporaryParent = await mkdtemp(path.join(os.tmpdir(), 'merchroute-s015-contract-'));
  context.after(() => rm(temporaryParent, { recursive: true, force: true }));
  const actualParent = path.join(temporaryParent, 'real');
  const aliasParent = path.join(temporaryParent, 'alias');
  await mkdir(actualParent);
  await symlink(actualParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
  // macOS temp paths can traverse /var -> /private/var. Use canonical fixture
  // paths, as required by the renderer's strict output containment checks.
  // A synthetic parent alias exercises this on Windows and Linux too.
  const root = await realpath(await mkdtemp(path.join(aliasParent, "render-o'brien-中文-")));
  assert.equal(path.dirname(root), await realpath(actualParent));
  const source = path.join(root, 'source');
  const outputParent = path.join(root, 'output');
  const outputSubDir = path.join(outputParent, 'job');
  const runtimeTemp = path.join(root, 'runtime-temp');
  await mkdir(source, { recursive: true });
  await mkdir(outputSubDir, { recursive: true });
  await mkdir(runtimeTemp, { recursive: true });
  const imagePaths = [path.join(source, "01-red-o'brien.png"), path.join(source, '02-blue-中文.png')];
  for (const [index, imagePath] of imagePaths.entries()) {
    const color = index === 0 ? 'red' : 'blue';
    const generated = spawnSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=0.04`, '-frames:v', '1', imagePath], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
  }
  const musicPath = path.join(source, 'tone-中文.wav');
  const generatedMusic = spawnSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', musicPath], { encoding: 'utf8' });
  assert.equal(generatedMusic.status, 0, generatedMusic.stderr);

  const rawWorkflow = await readWorkflow('x8D4EHfqI2DHcgL7');
  const workflow = materializeWorkflow(rawWorkflow, {
    MERCHROUTE_N8N_RUNTIME_DIR: path.join(root, 'runtime'),
    MERCHROUTE_DATA_ROOT: root,
    MERCHROUTE_BROWSER_PROFILE_ROOT: path.join(root, 'profiles'),
    MERCHROUTE_BROWSER_EXECUTABLE: path.join(root, 'chrome'),
    MERCHROUTE_TEMP_DIR: runtimeTemp,
  });
  const loadCode = requireNode(workflow, 'Load Preset Config').parameters.jsCode;
  const buildCode = requireNode(workflow, 'Build FFmpeg Command').parameters.jsCode;
  const resultCode = requireNode(workflow, 'Build Render Result').parameters.jsCode;
  const job = {
    imagePaths,
    sourceChildDir: source,
    outputSubDir,
    outputVideoPath: path.join(outputSubDir, 'synthetic.mp4'),
    effectPreset: 'case1',
    params: {
      outputParentDir: outputParent,
      ffmpegPath,
      musicPath,
      maxImageCount: 10,
      enableLogo: false,
      logoPosition: 'top_left',
      transitionDuration: 0,
      audioVolume: 0,
      audioFadeIn: 0,
      audioFadeOut: 0,
      width: 320,
      height: 240,
      fps: 25,
      targetDuration: 2,
    },
  };
  const load = new Function('require', '$input', loadCode);
  const loaded = load(require, { first: () => ({ json: job }) })[0].json;
  const build = new Function('require', 'Buffer', '$input', '$execution', buildCode);
  const commandInfo = build(require, Buffer, { first: () => ({ json: loaded }) }, { id: '900001' })[0].json;
  const renderRun = spawnSync(commandInfo.command, { shell: true, encoding: 'utf8', timeout: 30_000 });
  assert.equal(renderRun.status, 0, renderRun.stderr);
  const verifyRun = spawnSync(commandInfo.verifyCommand, { shell: true, encoding: 'utf8', timeout: 15_000 });
  assert.equal(verifyRun.status, 0, verifyRun.stderr);
  const nodeOutput = {
    'Run FFmpeg Render': { stdout: renderRun.stdout, stderr: renderRun.stderr },
    'Build FFmpeg Command': commandInfo,
  };
  const buildResult = new Function('$input', '$', resultCode);
  const [result] = buildResult({ first: () => ({ json: { stdout: verifyRun.stdout, stderr: verifyRun.stderr } }) }, (name) => ({ first: () => ({ json: nodeOutput[name] }) }));
  assert.equal(result.json.success, true);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.mediaProbe.videoCodec, 'h264');
  assert.equal(result.json.mediaProbe.audioCodec, 'aac');
  assert.equal(result.json.mediaProbe.width, 320);
  assert.equal(result.json.mediaProbe.height, 240);
  assert.ok(result.json.sizeBytes > 0);
});
