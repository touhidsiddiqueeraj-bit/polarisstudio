const fs = require('fs');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const HF = 'huggingface.co';

function hfGet(urlPath, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: HF, path: urlPath, headers: { 'User-Agent': 'polarisstudio' }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HF ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('HF timeout')));
    req.on('error', reject);
  });
}

// search models; filter param `gguf` keeps GGUFs, and we only want repos that also
// look runnable on this machine (skip mradermacher-style megarepos by client-side filter)
async function search(q, limit = 30) {
  const params = new URLSearchParams({ search: q, filter: 'gguf', sort: 'downloads', direction: '-1', limit: String(limit) });
  const models = await hfGet('/api/models?' + params);
  return models.map((m) => ({
    id: m.id,
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    lastModified: m.lastModified,
    pipelineTag: (m.pipeline_tag || '').toLowerCase(),
    tags: (m.tags || []).filter((t) => !t.startsWith('license:')).slice(0, 6),
    sha: m.sha
  }));
}

// sizes come from the JSON tree API (real bytes); the HTML tree page has no sizes,
// so it's only a fallback if the API call fails
async function listFiles(repoId) {
  let files;
  try {
    const tree = await hfGet(`/api/models/${repoId.split('/').map(encodeURIComponent).join('/')}/tree/main`);
    files = (Array.isArray(tree) ? tree : [])
      .filter((e) => e.type === 'file' && /\.(gguf|safetensors)$/i.test(e.path))
      .slice(0, 100)
      .map((e) => ({ file: e.path, size: e.size || (e.lfs && e.lfs.size) || null }));
  } catch (e) {
    files = await scrapeTree(repoId);
  }
  return { id: repoId, files };
}

async function scrapeTree(repoId) {
  const html = await hfGetHtml(`/${repoId}/tree/main`);
  const files = [];
  const re = /href="\/[^"]+\/blob\/main\/([^"?#]+\.(?:gguf|safetensors))"/g;
  let m;
  while ((m = re.exec(html)) && files.length < 100) {
    const file = decodeURIComponent(m[1]);
    if (!files.some((f) => f.file === file)) files.push({ file, size: null });
  }
  return files;
}

function hfGetHtml(urlPath, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: HF, path: urlPath, headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)', Accept: 'text/html' }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HF ${res.statusCode}`));
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('HF timeout')));
    req.on('error', reject);
  });
}

function resolveUrl(repoId, file) {
  return `https://${HF}/${repoId}/resolve/main/${encodeURIComponent(file)}`;
}

// resumable download: writes to <dest>.part, renames on completion
class Download extends EventEmitter {
  constructor(repoId, file, destDir, headers = {}) {
    super();
    this.url = resolveUrl(repoId, file);
    this.file = file;
    this.dest = path.join(destDir, path.basename(file));
    this.part = this.dest + '.part';
    this.headers = headers;
    this.aborted = false;
  }

  async start() {
    fs.mkdirSync(path.dirname(this.dest), { recursive: true });
    const stat = fs.existsSync(this.part) ? fs.statSync(this.part) : { size: 0 };
    const headers = { 'User-Agent': 'polarisstudio', ...this.headers };
    if (stat.size > 0) headers.Range = `bytes=${stat.size}-`;
    // resolve URL -> follows the HF 302 to the CDN (https.get does not auto-follow)
    const target = await followRedirects(this.url, headers);
    if (target.status >= 400) throw new Error(`HF ${target.status}`);
    return new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(this.part, { flags: 'a' });
      const req = https.get(target.url, { headers }, (res) => {
        if (res.statusCode === 416) {
          stream.end(() => {
            if (stat.size > 0) fs.renameSync(this.part, this.dest);
            this.emit('progress', { bytes: stat.size, total: stat.size });
            this.emit('done', { dest: this.dest, total: stat.size });
            resolve();
          });
          return;
        }
        if (res.statusCode === 206) this.emit('progress', { bytes: stat.size, total: stat.size + Number(res.headers['content-range'].split('/')[1]) });
        const total = stat.size + Number(res.headers['content-length'] || 0);
        res.on('data', (c) => {
          if (this.aborted) return req.destroy();
          stream.write(c);
          this.emit('progress', { bytes: stat.size + stream.bytesWritten, total });
        });
        res.on('end', () => {
          stream.end(() => {
            if (this.aborted) return;
            fs.renameSync(this.part, this.dest);
            this.emit('done', { dest: this.dest, total: fs.statSync(this.dest).size });
            resolve();
          });
        });
      });
      req.on('error', (e) => { stream.destroy(); reject(e); });
    });
  }

  abort() { this.aborted = true; }
}

function followRedirects(url, headers, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers, method: 'HEAD' }, (res) => {
      res.resume();
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(followRedirects(new URL(res.headers.location, url).href, headers, hops + 1));
      }
      resolve({ url, status: res.statusCode });
    });
    req.on('error', reject);
  });
}

module.exports = { search, listFiles, Download, resolveUrl };
