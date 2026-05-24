#!/usr/bin/env node

/**
 * PI Extension System - Automatic background context management
 * 
 * Supports multiple projects in parallel:
 * - Each project uses a unique port (auto-assigned based on path hash or manual)
 * - PID files are project-specific (in .pi/ directory)
 * - HTTP API bound to localhost with project-specific port
 * 
 * Usage: pi agent start [--port 4733]
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PI_DIR = '.pi';
const DEFAULT_PORT = 4732;
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
  port: number;
}

const defaultConfig: ExtensionConfig = {
  autoSync: true,
  autoSyncDelay: DEBOUNCE_MS,
  gitHooks: true,
  httpApi: true,
  statusBar: true,
  port: DEFAULT_PORT,
};

/**
 * Generate a unique port based on project path
 */
function generatePort(projectRoot: string, preferredPort?: number): number {
  if (preferredPort) return preferredPort;
  
  // Hash the project path to get a consistent port in range 4732-4932
  let hash = 0;
  for (let i = 0; i < projectRoot.length; i++) {
    const char = projectRoot.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  
  // Map hash to port range 4732-4932 (200 possible ports)
  return 4732 + Math.abs(hash % 200);
}

/**
 * Get project identifier (for display/logs)
 */
function getProjectId(projectRoot: string): string {
  const name = path.basename(projectRoot);
  return name;
}

class PIExtension {
  private projectRoot: string;
  private projectId: string;
  private config: ExtensionConfig;
  private watcher: fs.FSWatcher | null = null;
  private server: http.Server | null = null;
  private isRunning: boolean = false;
  private lastSync: number = 0;
  private pendingSync: NodeJS.Timeout | null = null;
  private pidFile: string;
  private cliPath: string;

  constructor(projectRoot: string, config: Partial<ExtensionConfig> = {}) {
    this.projectRoot = projectRoot;
    this.projectId = getProjectId(projectRoot);
    this.config = { ...defaultConfig, ...config };
    
    // Use project-specific port
    this.config.port = generatePort(projectRoot, config.port);
    
    // Project-specific PID file
    this.pidFile = path.join(PI_DIR, `extension.${this.projectId}.pid`);
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
      log.warn(`[${this.projectId}] PI Extension already running on port ${this.config.port}`);
      return;
    }

    // Ensure .pi exists
    if (!fs.existsSync(path.join(this.projectRoot, PI_DIR))) {
      log.info(`[${this.projectId}] Initializing .pi/ directory...`);
      this.runCli('init');
    }

    // Save PID and port
    fs.writeFileSync(this.pidFile, JSON.stringify({
      pid: process.pid,
      port: this.config.port,
      projectRoot: this.projectRoot,
      startedAt: new Date().toISOString(),
    }));

    this.isRunning = true;
    log.success(`[${this.projectId}] PI Extension started (port ${this.config.port})`);

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

    log.info(`[${this.projectId}] Automatic context management active`);
    log.info(`[${this.projectId}] API: http://localhost:${this.config.port}`);
    log.info(`[${this.projectId}] Press Ctrl+C to stop`);
  }

  /**
   * Stop the extension
   */
  stop(): void {
    if (!this.isRunning) {
      log.info(`[${this.projectId}] PI Extension not running`);
      return;
    }

    if (this.pendingSync) clearTimeout(this.pendingSync);
    if (this.watcher) this.watcher.close();
    if (this.server) this.server.close();
    
    // Remove PID file
    if (fs.existsSync(this.pidFile)) {
      fs.unlinkSync(this.pidFile);
    }

    this.isRunning = false;
    log.success(`[${this.projectId}] PI Extension stopped`);
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
    log.info(`[${this.projectId}] Syncing...`);

    try {
      this.runCli('sync', ['--scope', 'all']);
      log.success(`[${this.projectId}] Sync complete`);
    } catch (error) {
      log.error(`[${this.projectId}] Sync failed: ${String(error)}`);
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
          log.info(`[${this.projectId}] Change: ${relativePath}`);
          await this.sync();
        }, this.config.autoSyncDelay);
      }
    };

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
    log.success(`[${this.projectId}] File watcher active`);
  }

  /**
   * Install git hooks
   */
  private installGitHooks(): void {
    const hooksDir = path.join(this.projectRoot, '.git', 'hooks');
    if (!fs.existsSync(hooksDir)) return;

    const cli = this.cliPath;
    const port = this.config.port;

    const hookTemplate = (action: string, command: string) => [
      '#!/bin/sh',
      `# PI Extension [${this.projectId}]: ${action}`,
      `if [ -f "${cli}" ]; then`,
      `  node "${cli}" ${command} 2>/dev/null || true`,
      'fi',
    ].join('\n');

    fs.writeFileSync(path.join(hooksDir, 'post-commit'), hookTemplate('post-commit', 'summarize'));
    fs.writeFileSync(path.join(hooksDir, 'post-merge'), hookTemplate('post-merge', 'sync'));
    fs.writeFileSync(path.join(hooksDir, 'post-checkout'), hookTemplate('post-checkout', 'sync'));

    ['post-commit', 'post-merge', 'post-checkout'].forEach(hook => {
      fs.chmodSync(path.join(hooksDir, hook), 0o755);
    });

    log.success(`[${this.projectId}] Git hooks installed`);
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

      const url = new URL(req.url || '/', `http://localhost:${this.config.port}`);
      const pathname = url.pathname;

      try {
        switch (pathname) {
          case '/health':
            res.writeHead(200);
            res.end(JSON.stringify({ 
              status: 'ok', 
              running: this.isRunning,
              project: this.projectId,
              port: this.config.port,
            }));
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
              project: this.projectId,
              port: this.config.port,
              endpoints: ['/health', '/context', '/status', '/sync'],
            }));
        }
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
      }
    });

    this.server.listen(this.config.port, '127.0.0.1', () => {
      log.success(`[${this.projectId}] HTTP API at http://localhost:${this.config.port}`);
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

  private showStatusBar(): void {
    const statusFile = path.join(PI_DIR, 'status.json');
    
    const updateStatus = () => {
      try {
        const statusOutput = this.runCli('status', ['--json']);
        const statusData = JSON.parse(statusOutput);
        statusData._meta = {
          project: this.projectId,
          port: this.config.port,
          updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(statusFile, JSON.stringify(statusData, null, 2));
      } catch {
        // Ignore
      }
    };

    updateStatus();
    setInterval(updateStatus, 30000);
  }

  private runCli(command: string, args: string[] = []): string {
    if (!fs.existsSync(this.cliPath)) {
      throw new Error('CLI not found. Run: npm run build');
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

  private setupSignals(): void {
    const cleanup = () => this.stop();
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', cleanup);
  }

  private isPidRunning(): boolean {
    if (!fs.existsSync(this.pidFile)) return false;
    
    try {
      const data = JSON.parse(fs.readFileSync(this.pidFile, 'utf-8'));
      process.kill(data.pid, 0);
      return true;
    } catch {
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
      return false;
    }
  }

  isActive(): boolean {
    return this.isRunning && this.isPidRunning();
  }

  getPort(): number {
    return this.config.port;
  }

  getProjectId(): string {
    return this.projectId;
  }
}

/**
 * List all running PI Extensions
 */
function listRunningExtensions(projectRoot: string): void {
  const piDir = path.join(projectRoot, PI_DIR);
  
  console.log('\nRunning PI Extensions:\n');
  
  let found = false;
  try {
    const files = fs.readdirSync(piDir);
    for (const file of files) {
      if (file.startsWith('extension.') && file.endsWith('.pid')) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(piDir, file), 'utf-8'));
          console.log(`  ${data.project || 'unknown'} | port ${data.port} | PID ${data.pid}`);
          found = true;
        } catch {
          // Invalid PID file
        }
      }
    }
  } catch {
    // .pi dir doesn't exist
  }
  
  if (!found) {
    console.log('  No extensions running');
  }
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0] || 'help';
  const projectRoot = process.cwd();

  // Parse port option
  const portIndex = args.indexOf('--port');
  const port = portIndex !== -1 ? parseInt(args[portIndex + 1]) : undefined;

  const extension = new PIExtension(projectRoot, { port });

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
        log.success(`[${extension.getProjectId()}] PI Extension running on port ${extension.getPort()}`);
      } else {
        log.info(`[${extension.getProjectId()}] PI Extension not running (port ${port || 'auto'})`);
      }
      break;

    case 'list':
      listRunningExtensions(projectRoot);
      break;

    case 'sync':
      await extension.sync();
      break;

    case 'help':
    default:
      if (action !== 'help') {
        log.info('Unknown command: ' + action);
      }
      printAgentHelp();
  }
}

function printAgentHelp() {
  console.log(`
PI Extension - Automatic Project Context

Usage: pi agent <command>

Commands:
  start    Start the PI Extension
  stop     Stop the PI Extension
  restart  Restart the PI Extension
  status   Check if extension is running
  list     List all running extensions
  sync     Trigger immediate sync

Options:
  --port N  Use specific port (default: auto-assigned)

Features (enabled by default):
  - File watcher - auto-syncs graphs on file changes
  - Git hooks - syncs after commits, pulls, checkouts
  - HTTP API - query context via localhost
  - Status updates - updates .pi/status.json every 30s

Multiple Projects:
  Each project gets its own port automatically.
  Run 'pi agent list' to see all running instances.
  Query specific project: curl http://localhost:PORT/context

API Endpoints (per project):
  GET /health    - Health check
  GET /context   - Full runtime context
  GET /status    - Project status
  GET /sync      - Trigger sync
  `);
}

// Only run main if this file is executed directly
const isMain = process.argv[1]?.endsWith('agent.js') || process.argv[1]?.endsWith('agent.ts');

if (isMain) {
  main().catch(error => {
    log.error(String(error));
    process.exit(1);
  });
}

export { PIExtension, listRunningExtensions };