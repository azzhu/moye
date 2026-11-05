import { spawn } from 'node:child_process';
import { access, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOYE_ROOT, MAX_DOCUMENT_BYTES } from './local-service.mjs';

const runtimeFile = join(MOYE_ROOT, '.moye-runtime.json');
const startupLock = join(MOYE_ROOT, '.moye-start.lock');

async function serviceRequest(state, path, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${state.port}/__moye/${path}`, {
    method, signal: AbortSignal.timeout(15000),
    headers: { 'X-Moye-Admin': state.secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '本地服务请求失败');
  return data;
}

async function runningService() {
  try {
    const state = JSON.parse(await readFile(runtimeFile, 'utf8'));
    if (state.root !== MOYE_ROOT || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || !/^[a-f0-9]{64}$/.test(state.secret)) return null;
    const status = await serviceRequest(state, 'status');
    return status.app === 'moye' && status.root === MOYE_ROOT ? { ...state, capabilities: status.capabilities || [] } : null;
  } catch { return null; }
}

async function startService() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./local-service.mjs', import.meta.url))], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const state = await new Promise((resolveState, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('本地服务启动超时')); }, 10000);
    const cleanup = () => { clearTimeout(timer); child.removeAllListeners('error'); child.removeAllListeners('exit'); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', () => { cleanup(); reject(new Error('本地服务启动失败')); });
    child.once('message', message => { cleanup(); message.error ? reject(new Error(message.error)) : resolveState(message); });
  });
  try {
    const temporary = `${runtimeFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, runtimeFile);
  } catch (error) { child.kill(); throw error; }
  child.disconnect(); child.unref();
  return state;
}

async function obtainService() {
  const existing = await runningService();
  if (existing) return existing;
  // Serialize concurrent terminal invocations without spawning duplicate services.
  for (let attempt = 0; attempt < 120; attempt++) {
    let lock;
    try { lock = await open(startupLock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - (await stat(startupLock)).mtimeMs > 30000) await rm(startupLock, { force: true }); } catch {}
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
      const ready = await runningService();
      if (ready) return ready;
      continue;
    }
    try { return await runningService() || await startService(); }
    finally { await lock.close(); await rm(startupLock, { force: true }); }
  }
  throw new Error('其他终端正在启动墨页，请稍后重试');
}

export async function browserOpen(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise((resolveOpen, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveOpen() : reject(new Error('浏览器未能自动打开，请复制上面的地址访问')));
  });
}

export function requireCurrentMoyeService(state) {
  if (!state.capabilities?.includes('local-images-v1')) {
    throw new Error('后台墨页服务版本较旧，尚不支持本地图片。请先确认所有网页修改已保存，再执行 moye --stop，然后重新运行 moye 打开文件');
  }
}

export function parseMoyeArgs(args) {
  if (args.length === 1 && args[0] === '--stop') return { stop: true };
  let noBrowser = false; let options = true; const paths = [];
  for (const arg of args) {
    if (options && arg === '--') { options = false; continue; }
    if (options && ['--help', '-h'].includes(arg)) return { help: true };
    if (options && arg === '--no-browser') { noBrowser = true; continue; }
    if (options && arg.startsWith('-')) throw new Error(`未知选项 ${arg}，使用 --help 查看用法`);
    paths.push(arg);
  }
  if (paths.length !== 1) throw new Error('请指定一个 Markdown 文件，例如：moye "./我的文档.md"');
  return { path: paths[0], noBrowser };
}

export async function launchMoye(args) {
  const parsed = parseMoyeArgs(args);
  if (parsed.help) {
    console.log('用法：moye [--no-browser] [--] <Markdown 文件路径>\n      moye --stop\n\n自动打开浏览器，修改实时写回原文件。支持相对路径、绝对路径和带空格的路径。\n--no-browser  只输出打开地址\n--stop        停止本地服务（请先确认网页修改已保存）');
    return;
  }
  if (parsed.stop) {
    const state = await runningService();
    if (state) { await serviceRequest(state, 'stop', 'POST'); console.log('墨页本地服务已停止'); }
    else console.log('墨页本地服务未运行');
    return;
  }
  const path = await realpath(resolve(parsed.path));
  const info = await stat(path);
  if (!info.isFile() || !/\.(md|markdown|txt)$/i.test(path)) throw new Error('请选择已有的 .md、.markdown 或 .txt 文件');
  if (info.size > MAX_DOCUMENT_BYTES) throw new Error('请选择小于 2 MB 的 Markdown 文档');
  await access(path, constants.R_OK | constants.W_OK);
  const state = await obtainService();
  requireCurrentMoyeService(state);
  const file = await serviceRequest(state, 'open', 'POST', { path });
  const url = `http://127.0.0.1:${state.port}/#moye=${file.token}`;
  console.log(`原文件：${file.path}\n打开地址：${url}`);
  if (!parsed.noBrowser) await browserOpen(url);
}
