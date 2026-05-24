import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  SymbolNode,
  SymbolGraph,
  DependencyGraph,
  FileGraph,
  GraphUpdate,
  PackageNode,
} from '../types.js';

export interface GraphEngineConfig {
  projectRoot: string;
  piDir: string;
  incremental?: boolean;
}

interface ParsedSymbol {
  name: string;
  type: SymbolNode['type'];
  line: number;
  file: string;
  depends_on: string[];
}

export class GraphEngine {
  private projectRoot: string;
  private piDir: string;
  private incremental: boolean;

  constructor(config: GraphEngineConfig) {
    this.projectRoot = config.projectRoot;
    this.piDir = config.piDir;
    this.incremental = config.incremental ?? true;
  }

  /**
   * Update all graphs
   */
  async syncAll(): Promise<{ symbol: number; dependency: number; file: number }> {
    const results = await Promise.all([
      this.syncSymbolGraph(),
      this.syncDependencyGraph(),
      this.syncFileGraph(),
    ]);

    return {
      symbol: results[0],
      dependency: results[1],
      file: results[2],
    };
  }

  /**
   * Update symbol graph using tree-sitter or ripgrep
   */
  async syncSymbolGraph(changedFiles?: string[]): Promise<number> {
    const symbols = await this.extractSymbols(changedFiles);
    const symbolMap = new Map<string, SymbolNode>();

    for (const sym of symbols) {
      symbolMap.set(`${sym.file}:${sym.name}`, {
        name: sym.name,
        type: sym.type,
        file: sym.file,
        line: sym.line,
        depends_on: sym.depends_on,
        defined_in: sym.file,
      });
    }

    const graph: SymbolGraph = {
      nodes: symbolMap,
      lastUpdated: new Date().toISOString(),
    };

    const graphPath = path.join(this.piDir, 'graph', 'symbol_graph.json');
    fs.writeFileSync(graphPath, JSON.stringify(Object.fromEntries(graph.nodes), null, 2));

    return symbols.length;
  }

  /**
   * Extract symbols from source files
   */
  private async extractSymbols(changedFiles?: string[]): Promise<ParsedSymbol[]> {
    const sourceFiles = this.getSourceFiles(changedFiles);
    const symbols: ParsedSymbol[] = [];

    for (const file of sourceFiles) {
      const ext = path.extname(file);
      
      if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
        const fileSymbols = await this.extractJSSymbols(file);
        symbols.push(...fileSymbols);
      } else if (ext === '.py') {
        const fileSymbols = await this.extractPySymbols(file);
        symbols.push(...fileSymbols);
      }
    }

    return symbols;
  }

  /**
   * Get list of source files to analyze
   */
  private getSourceFiles(changedFiles?: string[]): string[] {
    if (changedFiles && changedFiles.length > 0) {
      return changedFiles.filter(f => 
        /\.(ts|js|tsx|jsx|py)$/.test(f) && 
        !f.includes('node_modules') && 
        !f.includes('.pi/')
      );
    }

    // Find all source files
    const patterns = [
      '**/*.ts',
      '**/*.tsx',
      '**/*.js',
      '**/*.jsx',
      '**/*.py',
    ];

    const files: string[] = [];
    for (const pattern of patterns) {
      try {
        const result = execSync(`find . -type f -name "${pattern}" -not -path "*/node_modules/*" -not -path "*/.pi/*" 2>/dev/null`, {
          cwd: this.projectRoot,
          encoding: 'utf-8',
          timeout: 30000,
        });
        files.push(...result.split('\n').filter(f => f.trim()));
      } catch {
        // Ignore errors
      }
    }

    return files;
  }

  /**
   * Extract symbols from JS/TS files using ripgrep
   */
  private async extractJSSymbols(file: string): Promise<ParsedSymbol[]> {
    const symbols: ParsedSymbol[] = [];

    try {
      // Extract classes
      const classRegex = /^class\s+(\w+)/m;
      const classMatches = execSync(`grep -n "^class " "${file}" 2>/dev/null || true`, { encoding: 'utf-8' });
      for (const match of classMatches.split('\n')) {
        const lineMatch = match.match(/^(\d+):.*class\s+(\w+)/);
        if (lineMatch) {
          symbols.push({
            name: lineMatch[2],
            type: 'class',
            line: parseInt(lineMatch[1], 10),
            file,
            depends_on: [],
          });
        }
      }

      // Extract functions (including async and exported)
      const funcRegex = /(?:^export\s+)?(?:async\s+)?function\s+(\w+)|(?:^export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/gm;
      const funcContent = fs.readFileSync(file, 'utf-8');
      let match;
      while ((match = funcRegex.exec(funcContent)) !== null) {
        const name = match[1] || match[2];
        const line = funcContent.substring(0, match.index).split('\n').length;
        symbols.push({
          name,
          type: 'function',
          line,
          file,
          depends_on: [],
        });
      }

      // Extract interfaces
      const interfaceMatches = execSync(`grep -n "^interface " "${file}" 2>/dev/null || true`, { encoding: 'utf-8' });
      for (const match of interfaceMatches.split('\n')) {
        const lineMatch = match.match(/^(\d+):.*interface\s+(\w+)/);
        if (lineMatch) {
          symbols.push({
            name: lineMatch[2],
            type: 'interface',
            line: parseInt(lineMatch[1], 10),
            file,
            depends_on: [],
          });
        }
      }

      // Extract types
      const typeMatches = execSync(`grep -n "^type " "${file}" 2>/dev/null || true`, { encoding: 'utf-8' });
      for (const match of typeMatches.split('\n')) {
        const lineMatch = match.match(/^(\d+):.*type\s+(\w+)/);
        if (lineMatch) {
          symbols.push({
            name: lineMatch[2],
            type: 'type',
            line: parseInt(lineMatch[1], 10),
            file,
            depends_on: [],
          });
        }
      }

      // Extract variable declarations (const, let, var)
      const varMatches = execSync(`grep -nE "^(const|let|var)\\s+" "${file}" 2>/dev/null || true`, { encoding: 'utf-8' });
      for (const match of varMatches.split('\n')) {
        const lineMatch = match.match(/^(\d+):(const|let|var)\s+(\w+)/);
        if (lineMatch && !lineMatch[3].startsWith('_')) {
          symbols.push({
            name: lineMatch[3],
            type: 'variable',
            line: parseInt(lineMatch[1], 10),
            file,
            depends_on: [],
          });
        }
      }
    } catch {
      // Skip files that can't be parsed
    }

    return symbols;
  }

  /**
   * Extract symbols from Python files
   */
  private async extractPySymbols(file: string): Promise<ParsedSymbol[]> {
    const symbols: ParsedSymbol[] = [];

    try {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Class definitions
        const classMatch = line.match(/^class\s+(\w+)/);
        if (classMatch) {
          symbols.push({
            name: classMatch[1],
            type: 'class',
            line: i + 1,
            file,
            depends_on: [],
          });
        }

        // Function definitions
        const funcMatch = line.match(/^(?:async\s+)?def\s+(\w+)/);
        if (funcMatch) {
          symbols.push({
            name: funcMatch[1],
            type: 'function',
            line: i + 1,
            file,
            depends_on: [],
          });
        }

        // Type aliases
        const typeMatch = line.match(/^(\w+)\s*=\s*(?:TypeAlias|list|dict|tuple)/);
        if (typeMatch) {
          symbols.push({
            name: typeMatch[1],
            type: 'type',
            line: i + 1,
            file,
            depends_on: [],
          });
        }
      }
    } catch {
      // Skip files that can't be parsed
    }

    return symbols;
  }

  /**
   * Update dependency graph (npm packages)
   */
  async syncDependencyGraph(): Promise<number> {
    const packageJsonPath = path.join(this.projectRoot, 'package.json');
    
    if (!fs.existsSync(packageJsonPath)) {
      return 0;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const packages = new Map<string, PackageNode>();

      // Add main package
      packages.set(packageJson.name, {
        name: packageJson.name,
        version: packageJson.version,
        dependencies: Object.keys(packageJson.dependencies ?? {}),
        dependents: [],
      });

      // Read node_modules for actual versions
      const nodeModulesPath = path.join(this.projectRoot, 'node_modules');
      if (fs.existsSync(nodeModulesPath)) {
        for (const [depName, depVersion] of Object.entries(packageJson.dependencies ?? {})) {
          const depPackagePath = path.join(nodeModulesPath, depName, 'package.json');
          if (fs.existsSync(depPackagePath)) {
            try {
              const depPackage = JSON.parse(fs.readFileSync(depPackagePath, 'utf-8'));
              packages.set(depName, {
                name: depName,
                version: depPackage.version,
                dependencies: Object.keys(depPackage.dependencies ?? {}),
                dependents: [packageJson.name],
              });
            } catch {
              // Use declared version if can't read
              packages.set(depName, {
                name: depName,
                version: String(depVersion),
                dependencies: [],
                dependents: [packageJson.name],
              });
            }
          }
        }
      }

      const graph: DependencyGraph = {
        packages,
        lastUpdated: new Date().toISOString(),
      };

      const graphPath = path.join(this.piDir, 'graph', 'dependency_graph.json');
      fs.writeFileSync(graphPath, JSON.stringify({
        packages: Object.fromEntries(graph.packages),
        lastUpdated: graph.lastUpdated,
      }, null, 2));

      return packages.size;
    } catch {
      return 0;
    }
  }

  /**
   * Update file graph (import relationships)
   */
  async syncFileGraph(changedFiles?: string[]): Promise<number> {
    const files = this.getSourceFiles(changedFiles);
    const edges = new Map<string, string[]>();

    for (const file of files) {
      const imports = this.extractImports(file);
      if (imports.length > 0) {
        edges.set(file, imports);
      }
    }

    const graph: FileGraph = {
      edges,
      lastUpdated: new Date().toISOString(),
    };

    const graphPath = path.join(this.piDir, 'graph', 'file_graph.json');
    fs.writeFileSync(graphPath, JSON.stringify(Object.fromEntries(graph.edges), null, 2));

    return edges.size;
  }

  /**
   * Extract imports from a file
   */
  private extractImports(file: string): string[] {
    const imports: string[] = [];

    try {
      const content = fs.readFileSync(file, 'utf-8');
      
      // ES modules imports
      const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        imports.push(match[1]);
      }

      // CommonJS requires
      const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((match = requireRegex.exec(content)) !== null) {
        imports.push(match[1]);
      }

      // Python imports
      const pyImportRegex = /(?:^from\s+(\S+)\s+import|^import\s+(\S+))/gm;
      while ((match = pyImportRegex.exec(content)) !== null) {
        const module = match[1] || match[2];
        if (module && !module.startsWith('.')) {
          imports.push(module);
        }
      }
    } catch {
      // Ignore parse errors
    }

    return [...new Set(imports)];
  }

  /**
   * Get graph context for a file or symbol
   */
  async getGraphContext(target: string): Promise<{
    relatedFiles: string[];
    relatedSymbols: string[];
    dependencies: string[];
  }> {
    const fileGraphPath = path.join(this.piDir, 'graph', 'file_graph.json');
    const symbolGraphPath = path.join(this.piDir, 'graph', 'symbol_graph.json');

    const fileGraph: Record<string, string[]> = fs.existsSync(fileGraphPath) 
      ? JSON.parse(fs.readFileSync(fileGraphPath, 'utf-8'))
      : {};
    const symbolGraph: Record<string, SymbolNode> = fs.existsSync(symbolGraphPath)
      ? JSON.parse(fs.readFileSync(symbolGraphPath, 'utf-8'))
      : {};

    const relatedFiles: string[] = [];
    const relatedSymbols: string[] = [];
    const dependencies: string[] = [];

    // Find files that import this target
    for (const [file, imports] of Object.entries(fileGraph)) {
      if (imports.some(imp => imp.includes(target) || file.includes(target))) {
        relatedFiles.push(file);
      }
    }

    // Find symbols in the target file
    for (const [key, symbol] of Object.entries(symbolGraph)) {
      if (symbol.file.includes(target)) {
        relatedSymbols.push(key);
        dependencies.push(...symbol.depends_on);
      }
    }

    return {
      relatedFiles: [...new Set(relatedFiles)],
      relatedSymbols: [...new Set(relatedSymbols)],
      dependencies: [...new Set(dependencies)],
    };
  }
}