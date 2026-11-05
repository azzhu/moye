// File-handle adapter for files explicitly opened by the local moye command.
export class LocalFileHandle {
  constructor(descriptor, request = (...args) => fetch(...args)) {
    this.type = 'moye-local-file';
    this.id = descriptor.id;
    this.token = descriptor.token;
    this.name = descriptor.name;
    this.path = descriptor.path;
    this.request = request;
  }

  toStoredHandle() { return { type: this.type, id: this.id, token: this.token, name: this.name, path: this.path }; }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
  async isSameEntry(other) { return other?.type === this.type && other.path === this.path; }

  async call(method = 'GET', body) {
    let response;
    try {
      response = await this.request('/__moye/file', {
        method, cache: 'no-store', credentials: 'omit',
        headers: { 'X-Moye-File': this.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error('本地墨页服务未连接，请在终端重新运行 moye 打开此文件'); }
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || '原文件读取或写入失败');
      if (response.status === 409) { error.code = 'EXTERNAL_MODIFICATION'; error.externalContent = data.content; }
      throw error;
    }
    return data;
  }

  async getFile() {
    const file = await this.call();
    this.id = file.id; this.name = file.name; this.path = file.path;
    return { name: file.name, size: file.size, lastModified: file.modified, text: async () => file.content };
  }

  async writeIfUnchanged(expectedContent, content) { await this.call('PUT', { expectedContent, content }); }
}

export async function localFileFromHash(hash) {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('moye');
  if (!token) return null;
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('命令行文件链接无效，请在终端重新打开文件');
  const handle = new LocalFileHandle({ token });
  await handle.getFile();
  return handle;
}
