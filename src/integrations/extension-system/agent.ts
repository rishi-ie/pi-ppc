#!/usr/bin/env node

/**
 * PI Extension System - Automatic background context management
 * 
 * Install once, runs automatically in background:
 * - File watcher (auto-sync on changes)
 * - Git hooks (auto-update on commits)
 * - Context API (for AI agents)
 * - Status bar updates
 * 
 * Usage: pi agent start
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PI_DIR = '.pi';
const PORT = 4732;
const DEBOUNCE_MS = 2000;

// Colors for output
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

const log = {
  info: (msg: string) => console.log(`${colors.cyan}[PI]${colors.reset} ${msg}`),
  success: (msg: string) => console.log(`${colors.green}[PI]${colors.reset} ${msg}`),
  warn: (msg: string) => console.log(`${colors.yellow}[PI]${colors.reset} ${msg}`),
  error: (msg: string) => console.log(`${colors.red}[PI]${colors.reset} ${msg}`),
};

interface ExtensionConfig {
  autoSync: boolean;
  autoSyncDelay: number;
  gitHooks: boolean;
  httpApi: boolean;
  statusBar: boolean;
}

const defaultConfig: ExtensionConfig = {
  autoSync: true,
  autoSyncDelay: DEBOUNCE_MS,
  gitHooks: true,
  httpApi: true,
  statusBar: true,
};

class PIExtension {
  private projectRoot: string;
  private config: ExtensionConfig;
  private watcher: fs.FSWatcher | null = null;
  private server: http.Server | null = null;
  private daemon: ChildProcess | null = null;
  private isRunning: boolean = false;
  private lastSync: number = 0;
  private pendingSync: NodeJS.Timeout | null = null;
  private pidFile: string;
  private cliPath: string;

  constructor(projectRoot: string, config: Partial<ExtensionConfig> = {}) {
    this.projectRoot = projectRoot;
    this.config = { ...defaultConfig, ...config };
    this.pidFile = path.join(PI_DIR, 'extension.pid');
    this.cliPath = this.findCliPath();
  }

  private findCliPath(): string {
    const paths = [
      path.join(this.projectRoot, 'dist', 'cli', 'index.js'),
      path.join(this.projectRoot, 'node_modules', 'pi-ppc', 'dist', 'cli', 'index.js'),
      path.join(__dirname, '..', '..', 'dist', 'cli', 'index.js'),
    ];
    
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return paths[0];
  }

  /**
   * Start the extension
   */
  async start(): Promise<void> {
    // Check if already running
    if (this.isPidRunning()) {
      log.warn('PI Extension already running. Run "pi agent stop" first.');
      return;
    }

    // Ensure .pi exists
    if (!fs.existsSync(path.join(this.projectRoot, PI_DIR))) {
      log.info('Initializing .pi/ directory...');
      this.runCli('init');
    }

    // Save PID
    fs.writeFileSync(this.pidFile, String(process.pid));

    this.isRunning = true;
    log.success('PI Extension started');

    // Initial sync
    await this.sync();

    // Start components
    if (this.config.autoSync) {
      this.startFileWatcher();
    }

    if (this.config.gitHooks) {
      this.installGitHooks();
    }

    if (this.config.httpApi) {
      this.startHttpApi();
    }

    if (this.config.statusBar) {
      this.showStatusBar();
    }

    // Setup signal handlers
    this.setupSignals();

    log.info('Automatic context management active');
    log.info('Press Ctrl+C or run "pi agent stop" to stop');
  }

  /**
   * Stop the extension
   */
  stop(): void {
    if (!this.isRunning) {
      log.info('PI Extension not running');
      return;
    }

    if (this.pendingSync) clearTimeout(this.pendingSync);
    if (this.watcher) this.watcher.close();
    if (this.server) this.server.close();
    if (this.daemon) this.daemon.kill();
    
    // Remove PID file
    if (fs.existsSync(this.pidFile)) {
      fs.unlinkSync(this.pidFile);
    }

    this.isRunning = false;
    log.success('PI Extension stopped');
  }

  /**
   * Restart the extension
   */
  async restart(): Promise<void> {
    this.stop();
    await new Promise(r => setTimeout(r, 500));
    await this.start();
  }

  /**
   * Sync all graphs
   */
  async sync(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSync < 3000) return;

    this.lastSync = now;
    log.info('Syncing...');

    try {
      this.runCli('sync', ['--scope', 'all']);
      log.success('Sync complete');
    } catch (error) {
      log.error('Sync failed: ' + String(error));
    }
  }

  /**
   * Start file watcher
   */
  private startFileWatcher(): void {
    const extensions = ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.json', '.md'];
    const ignoredDirs = ['node_modules', '.git', '.pi', 'dist', 'build', 'coverage', '.next', '.nuxt'];

    let debounceTimer: NodeJS.Timeout | null = null;

    const onChange = (filePath: string) => {
      const ext = path.extname(filePath);
      const shouldIgnore = ignoredDirs.some(d => filePath.includes(d));

      if (extensions.includes(ext) && !shouldIgnore) {
        if (debounceTimer) clearTimeout(debounceTimer);
        
        debounceTimer = setTimeout(async () => {
          const relativePath = path.relative(this.projectRoot, filePath);
          log.info('Change detected: ' + relativePath);
          await this.sync();
        }, this.config.autoSyncDelay);
      }
    };

    // Recursively watch all directories
    const watchDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (ignoredDirs.includes(entry.name)) continue;
          
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            watchDir(fullPath);
          }
        }
        
        // Watch this directory
        fs.watch(dir, (eventType, filename) => {
          if (filename) {
            const filePath = path.join(dir, filename);
            onChange(filePath);
          }
        });
      } catch {
        // Ignore permission errors
      }
    };

    watchDir(this.projectRoot);
    log.success('File watcher active');
  }

  /**
   * Install git hooks
   */
  private installGitHooks(): void {
    const hooksDir = path.join(this.projectRoot, '.git', 'hooks');
    if (!fs.existsSync(hooksDir)) return;

    const cli = this.cliPath;

    // Post-commit hook
    const postCommitHook = [
      '#!/bin/sh',
      '# PI Extension: Auto-update summary after commit',
      'if [ -f "' + cli + '" ]; then',
      '  node "' + cli + '" summarize 2>/dev/null || true',
      'fi',
    ].join('\n');

    // Post-merge hook (after pull)
    const postMergeHook = [
      '#!/bin/sh',
      '# PI Extension: Sync after pull',
      'if [ -f "' + cli + '" ]; then',
      '  node "' + cli + '" sync 2>/dev/null || true',
      'fi',
    ].join('\n');

    // Post-checkout hook
    const postCheckoutHook = [
      '#!/bin/sh',
      '# PI Extension: Sync after checkout',
      'if [ -f "' + cli + '" ]; then',
      '  node "' + cli + '" sync 2>/dev/null || true',
      'fi',
    ].join('\n');

    fs.writeFileSync(path.join(hooksDir, 'post-commit'), postCommitHook);
    fs.writeFileSync(path.join(hooksDir, 'post-merge'), postMergeHook);
    fs.writeFileSync(path.join(hooksDir, 'post-checkout'), postCheckoutHook);

    ['post-commit', 'post-merge', 'post-checkout'].forEach(hook => {
      fs.chmodSync(path.join(hooksDir, hook), 0o755);
    });

    log.success('Git hooks installed');
  }

  /**
   * Start HTTP API
   */
  private startHttpApi(): void {
    this.server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', 'http://localhost:' + PORT);
      const pathname = url.pathname;

      try {
        switch (pathname) {
          case '/health':
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'ok', running: this.isRunning }));
            break;
          case '/context':
            await this.handleContext(req, res);
            break;
          case '/status':
            await this.handleStatus(req, res);
            break;
          case '/sync':
            await this.handleSync(req, res);
            break;
          default:
            res.writeHead(200);
            res.end(JSON.stringify({
              name: 'PI Extension',
              version: '0.1.0',
              endpoints: ['/health', '/context', '/status', '/sync'],
            }));
        }
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
      }
    });

    this.server.listen(PORT, () => {
      log.success('HTTP API available at http://localhost:' + PORT);
    });
  }

  private async handleContext(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.writeHead(200);
    const output = this.runCli('context', ['--json']);
    res.end(output);
  }

  private async handleStatus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.writeHead(200);
    const output = this.runCli('status', ['--json']);
    res.end(output);
  }

  private async handleSync(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.writeHead(200);
    await this.sync();
    res.end(JSON.stringify({ synced: true }));
  }

  /**
   * Show status bar info
   */
  private showStatusBar(): void {
    const statusFile = path.join(PI_DIR, 'status.json');
    
    const updateStatus = () => {
      try {
        const statusOutput = this.runCli('status', ['--json']);
        fs.writeFileSync(statusFile, statusOutput);
      } catch {
        // Ignore
      }
    };

    updateStatus();
    setInterval(updateStatus, 30000);
  }

  /**
   * Run PI CLI command
   */
  private runCli(command: string, args: string[] = []): string {
    if (!fs.existsSync(this.cliPath)) {
      throw new Error('CLI not found at ' + this.cliPath + '. Run: npm run build');
    }

    try {
      return execSync('node "' + this.cliPath + '" ' + command + ' ' + args.join(' '), {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        timeout: 30000,
      });
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string };
      return execError.stdout || execError.stderr || String(error);
    }
  }

  /**
   * Setup signal handlers
   */
  private setupSignals(): void {
    const cleanup = () => this.stop();
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', cleanup);
  }

  /**
   * Check if PID is running
   */
  private isPidRunning(): boolean {
    if (!fs.existsSync(this.pidFile)) return false;
    
    try {
      const pid = parseInt(fs.readFileSync(this.pidFile, 'utf-8'));
      process.kill(pid, 0);
      return true;
    } catch {
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
      return false;
    }
  }

  /**
   * Check if extension is running
   */
  isActive(): boolean {
    return this.isRunning && this.isPidRunning();
  }
}

async function main() {
  const projectRoot = process.cwd();
  const args = process.argv.slice(2);
  const action = args[0] || 'help';

  const extension = new PIExtension(projectRoot);

  switch (action) {
    case 'start':
      await extension.start();
      await new Promise(() => {});
      break;

    case 'stop':
      extension.stop();
      break;

    case 'restart':
      await extension.restart();
      break;

    case 'status':
      if (extension.isActive()) {
        log.success('PI Extension is running');
      } else {
        log.info('PI Extension is not running');
      }
      break;

    case 'sync':
      await extension.sync();
      break;

    case 'help':
    default:
      console.log(`
PI Extension - Automatic Project Context

Usage: pi agent <command>

Commands:
  start    Start the PI Extension (runs in background)
  stop     Stop the PI Extension
  restart  Restart the PI Extension
  status   Check if extension is running
  sync     Trigger immediate sync

Features (enabled by default):
  - File watcher - auto-syncs graphs on file changes
  - Git hooks - syncs after commits, pulls, checkouts
  - HTTP API - query context via http://localhost:4732
  - Status updates - updates .pi/status.json every 30s

API Endpoints:
  GET /health    - Health check
  GET /context   - Full runtime context
  GET /status    - Project status
  GET /sync      - Trigger sync
      `);
  }
}

main().catch(error => {
  log.error(String(error));
  process.exit(1);
});

export { PIExtension };