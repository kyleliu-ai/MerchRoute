import { gzipSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../security.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const n8nRoot = path.resolve(scriptDir, '..');
const sourceRoot = path.join(n8nRoot, 'sources');
const manifestPath = path.join(n8nRoot, 'manifest.json');
const targets = {
  e004: path.join(n8nRoot, 'workflows', 'core', 'noHJuIiHfHryuA2e.json'),
  s015: path.join(n8nRoot, 'workflows', 'core', 'x8D4EHfqI2DHcgL7.json'),
};

const readSource = (name) => readFile(path.join(sourceRoot, name), 'utf8');
const nodeByName = (workflow, name) => {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`${workflow.id} 缺少节点 ${name}`);
  return node;
};

function replaceEmbeddedGzip(code, constantName, source) {
  const compressed = gzipSync(Buffer.from(source, 'utf8'), { level: 9 }).toString('base64');
  const pattern = new RegExp(`const ${constantName} = '[^']+';`);
  if (!pattern.test(code)) throw new Error(`缺少内嵌常量 ${constantName}`);
  return code.replace(pattern, `const ${constantName} = '${compressed}';`);
}

function replaceRequired(code, before, after, label) {
  if (code.includes(after)) return code;
  if (!code.includes(before)) throw new Error(`无法更新 ${label}`);
  return code.replace(before, after);
}

function updateS015BuildCode(original, renderSource) {
  let code = replaceEmbeddedGzip(original, 'S015_RENDER_SCRIPT_GZIP_BASE64', renderSource);
  code = replaceRequired(code,
    "const transition = (config.transition && config.transition.type) || 'fade', duration = Number(config.transitionDuration || 0.5);",
    "const transition = (config.transition && config.transition.type) || 'fade', duration = Number(config.transitionDuration ?? 0);",
    'S015 transitionDuration zero-value contract');
  code = replaceRequired(code,
    "if (imageCount === 1) return '[v0]format=yuv420p[vbase]';\n  const parts = []; let previous = 'v0';",
    "if (imageCount === 1) return '[v0]format=yuv420p[vbase]';\n  if (duration === 0) return Array.from({ length: imageCount }, (_, index) => '[v' + index + ']').join('') + 'concat=n=' + imageCount + ':v=1:a=0,format=yuv420p[vbase]';\n  const parts = []; let previous = 'v0';",
    'S015 zero-duration concat contract');
  code = replaceRequired(code, 'Number(config.logoWidth || 90)', 'Number(config.logoWidth ?? 90)', 'S015 logoWidth zero-value contract');
  code = replaceRequired(code, 'Number(config.logoMarginX || 12)', 'Number(config.logoMarginX ?? 12)', 'S015 logoMarginX zero-value contract');
  code = replaceRequired(code, 'Number(config.logoMarginY || 12)', 'Number(config.logoMarginY ?? 12)', 'S015 logoMarginY zero-value contract');
  code = replaceRequired(code,
    "const targetDuration = Number(preset.targetDuration || 10), fps = Number(preset.fps || 30), transitionDuration = imagePaths.length > 1 ? Number(preset.transitionDuration || 0.5) : 0;",
    "const targetDuration = Number(preset.targetDuration), fps = Number(preset.fps), transitionDuration = imagePaths.length > 1 ? Number(preset.transitionDuration ?? 0) : 0;",
    'S015 normalized duration contract');
  if (!code.includes("const partialOutputPath = normalizePath(path.join(outputSubDir, '_render_output.partial.mp4'));")) {
    code = replaceRequired(code,
      "const musicPath = normalizePath(preset.musicPath || ''), logoPath = preset.enableLogo ? normalizePath(preset.logoPath || '') : '';\nconst videoOnlyPath = musicPath ? normalizePath(path.join(outputSubDir, '_video_only.mp4')) : outputVideoPath;\nconst fadeOut = Number((preset.audio || {}).fadeOut || 2), fadeOutStart = Math.max(0, targetDuration - fadeOut);\nconst audioFilter = '[1:a]volume=' + Number((preset.audio || {}).volume || 0.25) + ',afade=t=in:st=0:d=' + Number((preset.audio || {}).fadeIn || 0.8) + ',afade=t=out:st=' + fadeOutStart.toFixed(3) + ':d=' + fadeOut + '[a]';",
      "const musicPath = preset.audio?.enabled ? normalizePath(preset.musicPath || '') : '';\nconst logoPath = preset.enableLogo ? normalizePath(preset.logoPath || '') : '';\nconst partialOutputPath = normalizePath(path.join(outputSubDir, '_render_output.partial.mp4'));\nconst videoOnlyPath = musicPath ? normalizePath(path.join(outputSubDir, '_video_only.mp4')) : partialOutputPath;\nconst fadeOut = Number((preset.audio || {}).fadeOut ?? 2), fadeOutStart = Math.max(0, targetDuration - fadeOut);\nconst audioFilter = '[1:a]volume=' + Number((preset.audio || {}).volume ?? 0.25) + ',afade=t=in:st=0:d=' + Number((preset.audio || {}).fadeIn ?? 0.8) + ',afade=t=out:st=' + fadeOutStart.toFixed(3) + ':d=' + fadeOut + '[a]';",
      'S015 audio and partial-output contract');
  }
  code = replaceRequired(code,
    "const audioFilter = '[1:a]volume=' + Number((preset.audio || {}).volume ?? 0.25) + ',afade=t=in:st=0:d=' + Number((preset.audio || {}).fadeIn ?? 0.8) + ',afade=t=out:st=' + fadeOutStart.toFixed(3) + ':d=' + fadeOut + '[a]';",
    "const audioFilterParts = ['volume=' + Number((preset.audio || {}).volume ?? 0.25)];\nconst fadeIn = Number((preset.audio || {}).fadeIn ?? 0.8);\nif (fadeIn > 0) audioFilterParts.push('afade=t=in:st=0:d=' + fadeIn);\nif (fadeOut > 0) audioFilterParts.push('afade=t=out:st=' + fadeOutStart.toFixed(3) + ':d=' + fadeOut);\nconst audioFilter = '[1:a]' + audioFilterParts.join(',') + '[a]';",
    'S015 zero-duration audio fade contract');
  code = replaceRequired(code,
    "const renderSpec = { ffmpegPath, imagePaths, logoPath, musicPath, outputSubDir, outputVideoPath, videoOnlyPath, filterComplex, audioFilter, fps, targetDuration, effectPreset: job.effectPreset || preset.effectPreset || 'case1' };",
    "const ffprobePath = normalizePath(path.join(path.dirname(ffmpegPath), /\\.exe$/i.test(ffmpegPath) ? 'ffprobe.exe' : 'ffprobe'));\nconst renderSpec = { ffmpegPath, ffprobePath, sourceChildDir: normalizePath(job.sourceChildDir), outputParentDir: normalizePath(job.params?.outputParentDir), imagePaths, logoPath, musicPath, outputSubDir, outputVideoPath, partialOutputPath, videoOnlyPath, filterComplex, audioFilter, fps, width: Number(preset.width), height: Number(preset.height), targetDuration, maxImageCount: Number(job.params?.maxImageCount), expectAudio: Boolean(musicPath), effectPreset: job.effectPreset || preset.effectPreset || 'case1' };",
    'S015 render spec boundary contract');
  code = replaceRequired(code,
    "fs.writeFileSync(renderSpecPath, JSON.stringify(renderSpec, null, 2), 'utf8');",
    "const renderSpecTemporaryPath = renderSpecPath + '.tmp-' + String($execution.id || Date.now());\nlet renderSpecWritten = false;\ntry {\n  fs.writeFileSync(renderSpecTemporaryPath, JSON.stringify(renderSpec, null, 2) + '\\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });\n  fs.renameSync(renderSpecTemporaryPath, renderSpecPath);\n  renderSpecWritten = true;\n} finally {\n  if (!renderSpecWritten && fs.existsSync(renderSpecTemporaryPath)) fs.rmSync(renderSpecTemporaryPath, { force: true });\n}",
    'S015 atomic render spec contract');

  let tailStart = code.indexOf('const verifyScript = ');
  if (tailStart < 0) tailStart = code.indexOf('const verifyScriptSource = ');
  if (tailStart < 0) throw new Error('S015 Build FFmpeg Command 缺少 verifyScript 尾段');
  const tail = String.raw`const verifyScriptSource = "const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');const p=JSON.parse(Buffer.from(process.argv[1]||'','base64').toString('utf8'));const out=path.resolve(p.outputVideoPath);if(!fs.existsSync(out)){console.error('output_missing');process.exit(2);}const st=fs.lstatSync(out);if(st.isSymbolicLink()||!st.isFile()||st.size<=0){console.error('output_invalid');process.exit(3);}const r=spawnSync(p.ffprobePath,['-v','error','-show_streams','-show_format','-of','json',out],{shell:false,windowsHide:true,encoding:'utf8',maxBuffer:8*1024*1024});if(r.error||r.status!==0){console.error(String(r.stderr||r.error?.message||'ffprobe_failed'));process.exit(4);}let q;try{q=JSON.parse(r.stdout||'{}');}catch{console.error('ffprobe_json_invalid');process.exit(5);}const streams=Array.isArray(q.streams)?q.streams:[];const v=streams.find(s=>s.codec_type==='video');const a=streams.find(s=>s.codec_type==='audio');if(!v||String(v.codec_name).toLowerCase()!=='h264'||(p.expectAudio&&(!a||String(a.codec_name).toLowerCase()!=='aac'))){console.error('media_stream_contract_failed');process.exit(6);}const rate=String(v.avg_frame_rate||v.r_frame_rate||'0/1').split('/').map(Number);const fps=rate[1]?rate[0]/rate[1]:0;const duration=Number(q.format?.duration||v.duration||0);const mediaProbe={videoCodec:String(v.codec_name||''),audioCodec:a?String(a.codec_name||''):null,width:Number(v.width),height:Number(v.height),fps:Number(fps.toFixed(3)),durationSeconds:Number(duration.toFixed(3)),formatName:String(q.format?.format_name||'')};console.log(JSON.stringify({success:true,outputVideoPath:out.replace(/\\\\/g,'/'),sizeBytes:st.size,mediaProbe}));";
const verifyPayload = Buffer.from(JSON.stringify({ outputVideoPath, ffprobePath, expectAudio: Boolean(musicPath) }), 'utf8').toString('base64');
return [{ json: { ...job, preset, command, verifyCommand: __buildNodeCommand(['-e', verifyScriptSource, verifyPayload]), partialOutputPath, videoOnlyPath, clipDuration, framesPerClip: frames, totalDuration: targetDuration, renderSpecPath, runnerCommandLength: command.length, renderInvocation: { mode: 'spawnSync-shell-false', renderer: 'ffmpeg', verifier: 'ffprobe', imageCount: imagePaths.length, logo: Boolean(logoPath), music: Boolean(musicPath) } } }];`;
  return `${code.slice(0, tailStart)}${tail}`;
}

const [e004Raw, s015Raw, waitSource, parseSource, collectSource, prepareSource, finalSource, loadSource, renderSource, resultSource] = await Promise.all([
  readFile(targets.e004, 'utf8'),
  readFile(targets.s015, 'utf8'),
  readSource('e004-wait-stable.cjs.txt'),
  readSource('e004-parse-stable.js.txt'),
  readSource('e004-collect-images.js.txt'),
  readSource('e004-prepare-job.js.txt'),
  readSource('e004-build-final.js.txt'),
  readSource('s015-load-preset.js.txt'),
  readSource('s015-render.cjs.txt'),
  readSource('s015-build-result.js.txt'),
]);

const e004 = JSON.parse(e004Raw);
e004.name = 'E004-v01-主图生视频-FFmpeg';
nodeByName(e004, 'Workflow Summary').parameters.content = `## E004-v01-主图生视频-FFmpeg

监听 E004 产品包；递归验证 \`_READY.json\`、\`selection-manifest.json\`、\`task-context.json\`、参数 JSON 与所有嵌套图片的身份、大小和 SHA-256 稳定窗口，然后调用 S015 生成视频。

- 拒绝符号链接、目录越界、未登记图片和永久无效控制文件。
- \`._E004_RENDER.lock\` 防止同一提交并发渲染；失败锁 30 分钟后才可回收。
- 输出目录先写入状态为 \`RENDERING\` 的 \`job.json\` / \`task-context.json\`；仅在 FFprobe 验证通过后写入 \`_COMPLETE.json\`。
- 最终回执要求 S015 同时返回 \`success=true\` 与 \`ok=true\`。

### 必需环境变量

\`NODE_FUNCTION_ALLOW_BUILTIN=fs,path\`；修改后必须重启 n8n。不要扩大为 \`*\`。`;
nodeByName(e004, 'Normalize Trigger Path').parameters.jsCode = replaceEmbeddedGzip(nodeByName(e004, 'Normalize Trigger Path').parameters.jsCode, 'E004_WAIT_STABLE_SCRIPT_GZIP_BASE64', waitSource);
nodeByName(e004, 'Parse Stable Result').parameters.jsCode = parseSource.trimEnd();
nodeByName(e004, 'Collect Image Files').parameters.jsCode = collectSource.trimEnd();
nodeByName(e004, 'Prepare Job Json').parameters.jsCode = prepareSource.trimEnd();
nodeByName(e004, 'Build Final Result').parameters.jsCode = finalSource.trimEnd();
const setParameter = nodeByName(e004, 'setParameter');
setParameter.parameters.assignments.assignments = setParameter.parameters.assignments.assignments.filter((assignment) => assignment.name !== 'waitStableScriptPath');

const s015 = JSON.parse(s015Raw);
nodeByName(s015, 'Workflow Summary').parameters.content = `## S015-v01-Render-主图生视频-加logo

仅负责 E004 视频渲染：严格校验图片、输出、FFmpeg、Logo、音乐和数值参数边界；先生成同目录临时 MP4，再用 FFprobe 验证 H.264、AAC（配置音乐时）、分辨率、帧率、时长和容器，成功后才发布最终文件。

- 直接调用同样受来源目录、输出目录和最大图片数约束。
- 显式的 \`0\` 音量、淡入淡出与转场时长不会被默认值覆盖。
- 成功结果不返回已删除的临时视频，也不重复保存完整 FFmpeg stderr。
- \`_render_spec.json\`、\`_render_output.partial.mp4\` 与 \`_video_only.mp4\` 仅为临时文件；成功后清理。`;
nodeByName(s015, 'Load Preset Config').parameters.jsCode = loadSource.trimEnd();
nodeByName(s015, 'Build FFmpeg Command').parameters.jsCode = updateS015BuildCode(nodeByName(s015, 'Build FFmpeg Command').parameters.jsCode, renderSource);
nodeByName(s015, 'Build Render Result').parameters.jsCode = resultSource.trimEnd();

const serialized = new Map([
  [e004.id, `${JSON.stringify(e004, null, 2)}\n`],
  [s015.id, `${JSON.stringify(s015, null, 2)}\n`],
]);
const workflowsChanged = serialized.get(e004.id) !== e004Raw || serialized.get(s015.id) !== s015Raw;
if (serialized.get(e004.id) !== e004Raw) await writeFile(targets.e004, serialized.get(e004.id), 'utf8');
if (serialized.get(s015.id) !== s015Raw) await writeFile(targets.s015, serialized.get(s015.id), 'utf8');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
for (const workflow of [e004, s015]) {
  const entry = manifest.workflows.find((candidate) => candidate.id === workflow.id);
  if (!entry) throw new Error(`manifest 缺少 ${workflow.id}`);
  entry.name = workflow.name;
  entry.active = workflow.active;
  entry.sha256 = sha256(serialized.get(workflow.id));
}
if (workflowsChanged) manifest.generatedAt = new Date().toISOString();
const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
if (manifestContent !== await readFile(manifestPath, 'utf8')) await writeFile(manifestPath, manifestContent, 'utf8');
console.log(`已同步 E004/S015 可审查源码：${e004.id}, ${s015.id}`);
