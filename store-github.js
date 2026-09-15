/**
 * store-github.js — keeps the numbers in a GitHub repo, not on Render's disk.
 *
 * Render's free tier wipes its filesystem on every redeploy and on cold starts,
 * which is why the visitor counts and the ledger kept resetting. This writes
 * them to a repo instead: the repo is the record, Render just reads it on boot
 * and pushes changes back.
 *
 *   const store = new GitHubStore({
 *     repo: 'you/voxelia-data',      // or the backend repo itself
 *     token: process.env.GITHUB_TOKEN,
 *     branch: 'main',
 *     dir: 'data'
 *   });
 *   await store.load('stats.json', fallbackObject);
 *   store.save('stats.json', obj);   // queued, written at most once a minute
 *
 * Without a token it quietly falls back to local files, so nothing breaks in
 * development.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const API = process.env.GITHUB_API || 'api.github.com';

class GitHubStore {
  constructor(opts = {}) {
    this.repo = opts.repo || process.env.GITHUB_REPO || '';
    this.token = opts.token || process.env.GITHUB_TOKEN || '';
    this.branch = opts.branch || process.env.GITHUB_BRANCH || 'main';
    this.dir = (opts.dir || process.env.GITHUB_DATA_DIR || 'data').replace(/^\/|\/$/g, '');
    this.local = opts.localDir || __dirname;
    this.host = opts.host || API;
    this.port = opts.port || 443;
    this.insecure = !!opts.insecure;          // for tests against a local stand-in
    this.minGapMs = opts.minGapMs || 60000;   // at most one commit a minute per file
    this.shas = {};
    this.pending = {};
    this.timers = {};
    this.lastWrite = {};
    this.log = opts.log || (() => {});
    this.enabled = !!(this.repo && this.token);
  }

  _request(method, route, body) {
    return new Promise((resolve) => {
      const payload = body ? JSON.stringify(body) : null;
      const mod = this.insecure ? require('http') : https;
      const req = mod.request({
        host: this.host,
        port: this.port,
        path: route,
        method,
        headers: Object.assign({
          'user-agent': 'voxelia-server',
          accept: 'application/vnd.github+json',
          authorization: 'Bearer ' + this.token
        }, payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        } : {})
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data || '{}'); } catch (e) { parsed = null; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', () => resolve({ status: 0, body: null }));
      req.setTimeout(12000, () => { req.destroy(); resolve({ status: 0, body: null }); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  _route(name) {
    return '/repos/' + this.repo + '/contents/' + this.dir + '/' + name +
           '?ref=' + encodeURIComponent(this.branch);
  }

  /** Read a file. Falls back to the local copy, then to what you pass in. */
  async load(name, fallback) {
    if (this.enabled) {
      const res = await this._request('GET', this._route(name));
      if (res.status === 200 && res.body && res.body.content) {
        this.shas[name] = res.body.sha;
        try {
          const text = Buffer.from(res.body.content, 'base64').toString('utf8');
          const parsed = JSON.parse(text);
          this.log('loaded ' + name + ' from ' + this.repo);
          return parsed;
        } catch (e) {
          this.log(name + ' in the repo could not be read; starting fresh');
        }
      } else if (res.status === 404) {
        this.log(name + ' is not in the repo yet; it will be created on the first write');
      } else if (res.status === 401 || res.status === 403) {
        this.log('GitHub refused the token, falling back to local files');
        this.enabled = false;
      }
    }
    // local copy, for development and as a safety net
    const file = path.join(this.local, name);
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
    }
    return fallback;
  }

  /** Queue a write. Repeated calls collapse into one commit a minute. */
  save(name, obj) {
    this.pending[name] = obj;
    // the local copy is written straight away, so a crash loses nothing
    try {
      fs.writeFile(path.join(this.local, name), JSON.stringify(obj), () => {});
    } catch (e) {}
    if (!this.enabled || this.timers[name]) return;
    const since = Date.now() - (this.lastWrite[name] || 0);
    const wait = Math.max(0, this.minGapMs - since);
    this.timers[name] = setTimeout(() => {
      this.timers[name] = null;
      this.flush(name);
    }, wait);
    if (this.timers[name].unref) this.timers[name].unref();
  }

  /** Commit one file now. */
  async flush(name) {
    if (!this.enabled) return false;
    const obj = this.pending[name];
    if (obj === undefined) return false;
    delete this.pending[name];
    this.lastWrite[name] = Date.now();

    const put = async () => this._request(
      'PUT',
      '/repos/' + this.repo + '/contents/' + this.dir + '/' + name,
      {
        message: 'voxelia: ' + name + ' ' + new Date().toISOString(),
        content: Buffer.from(JSON.stringify(obj)).toString('base64'),
        branch: this.branch,
        sha: this.shas[name]
      }
    );

    let res = await put();
    if (res.status === 409 || res.status === 422) {
      // somebody else wrote it: take the new sha and try once more
      const fresh = await this._request('GET', this._route(name));
      if (fresh.status === 200 && fresh.body) {
        this.shas[name] = fresh.body.sha;
        res = await put();
      }
    }
    if (res.status === 200 || res.status === 201) {
      if (res.body && res.body.content) this.shas[name] = res.body.content.sha;
      this.log('saved ' + name + ' to ' + this.repo);
      return true;
    }
    this.log('could not save ' + name + ' (status ' + res.status + '); the local copy still has it');
    return false;
  }

  /** Commit everything outstanding — call this on shutdown. */
  async flushAll() {
    for (const name of Object.keys(this.pending)) {
      if (this.timers[name]) { clearTimeout(this.timers[name]); this.timers[name] = null; }
      await this.flush(name);
    }
  }
}

module.exports = { GitHubStore };
