import path from "node:path";
import ts from "typescript";
import { loadCompilerOptions } from "./moduleResolver.js";
import type { ParsedSourceFile, SymbolDefinition } from "./types.js";

function toPosix(value: string) {
  return value.split(path.sep).join("/");
}

function toRelativePath(workspaceRoot: string, filePath: string) {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return toPosix(relative);
}

function declarationIdentifier(declaration: ts.Declaration) {
  const named = declaration as ts.Declaration & { name?: ts.DeclarationName };
  return named.name && ts.isIdentifier(named.name) ? named.name : undefined;
}

function unwrapAlias(checker: ts.TypeChecker, symbol: ts.Symbol) {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

/**
 * 使用 TypeChecker 将语法引用绑定到真实声明，避免同名局部变量和同名方法造成误关联。
 */
export function bindSemanticReferences(workspaceRoot: string, parsedFiles: ParsedSourceFile[]) {
  const codeFiles = parsedFiles.filter((file) => !file.filePath.endsWith(".vue"));
  if (!codeFiles.length) return;
  const rootNames = codeFiles.map((file) => path.resolve(workspaceRoot, file.filePath));
  const baseOptions = loadCompilerOptions(workspaceRoot, codeFiles[0].filePath);
  const options: ts.CompilerOptions = { ...baseOptions, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, jsx: baseOptions.jsx || ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options, true);

  // 不同 monorepo 子项目可能使用不同 paths，按发起导入的文件选择最近配置。
  const resolvingHost = host as ts.CompilerHost & {
    resolveModuleNames?: (moduleNames: string[], containingFile: string) => Array<ts.ResolvedModule | undefined>;
  };
  resolvingHost.resolveModuleNames = (moduleNames, containingFile) => {
    const fromFile = toRelativePath(workspaceRoot, containingFile) || containingFile;
    const compilerOptions = loadCompilerOptions(workspaceRoot, fromFile);
    return moduleNames.map((moduleName) => ts.resolveModuleName(moduleName, containingFile, compilerOptions, ts.sys).resolvedModule);
  };

  const program = ts.createProgram({ rootNames, options, host: resolvingHost });
  const checker = program.getTypeChecker();
  const symbolsByKey = new Map<string, SymbolDefinition>();
  const defaultSymbolsByFile = new Map<string, SymbolDefinition>();
  const referencesByKey = new Map<string, ParsedSourceFile["references"]>();
  const codeFilePaths = new Set(codeFiles.map((file) => file.filePath));
  const filesByPath = new Map(codeFiles.map((file) => [file.filePath, file]));
  const inferredTypeSources: Array<{ node: ts.Identifier; definition: SymbolDefinition }> = [];

  for (const file of codeFiles) {
    for (const symbol of file.symbols) {
      const offset = Number(symbol.id.slice(symbol.id.lastIndexOf("@") + 1));
      symbolsByKey.set(`${file.filePath}:${symbol.name}:${offset}`, symbol);
      if (symbol.defaultExport) defaultSymbolsByFile.set(file.filePath, symbol);
    }
    for (const reference of file.references) {
      const key = `${reference.line}:${reference.column}:${reference.name}`;
      const values = referencesByKey.get(`${file.filePath}:${key}`) || [];
      values.push(reference);
      referencesByKey.set(`${file.filePath}:${key}`, values);
      // TypeChecker 会为当前文件重新给出权威结果，先清除名称匹配产生的候选。
      reference.targetSymbolId = undefined;
    }
  }

  function resolveDefinition(symbol: ts.Symbol): SymbolDefinition | undefined {
    const target = unwrapAlias(checker, symbol);
    for (const declaration of target.getDeclarations() || []) {
      const filePath = toRelativePath(workspaceRoot, declaration.getSourceFile().fileName);
      if (!filePath) continue;
      const identifier = declarationIdentifier(declaration);
      if (identifier) {
        const found = symbolsByKey.get(`${filePath}:${identifier.text}:${identifier.getStart(declaration.getSourceFile())}`);
        if (found) return found;
      }
      const defaultSymbol = defaultSymbolsByFile.get(filePath);
      if (defaultSymbol && (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration) || ts.isExportAssignment(declaration))) return defaultSymbol;
    }
    return undefined;
  }

  function collectNamedTypes(type: ts.Type, output: Set<ts.Symbol>, depth = 0) {
    if (depth > 8) return;
    if (type.aliasSymbol) output.add(unwrapAlias(checker, type.aliasSymbol));
    if (type.getSymbol()) output.add(unwrapAlias(checker, type.getSymbol()!));
    if (type.isUnionOrIntersection()) for (const child of type.types) collectNamedTypes(child, output, depth + 1);
    for (const argument of (type as ts.TypeReference).typeArguments || []) collectNamedTypes(argument, output, depth + 1);
  }

  for (const sourceFile of program.getSourceFiles()) {
    const filePath = toRelativePath(workspaceRoot, sourceFile.fileName);
    if (!filePath || !codeFilePaths.has(filePath)) continue;

    function visit(node: ts.Node) {
      if (ts.isIdentifier(node)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const references = referencesByKey.get(`${filePath}:${position.line + 1}:${position.character + 1}:${node.text}`);
        if (references?.length) {
          const target = checker.getSymbolAtLocation(node);
          const definition = target ? resolveDefinition(target) : undefined;
          for (const reference of references) reference.targetSymbolId = definition?.id;
        }
        if (isDeclarationName(node)) {
          const declared = checker.getSymbolAtLocation(node);
          const definition = declared ? resolveDefinition(declared) : undefined;
          if (definition) inferredTypeSources.push({ node, definition });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }


  for (const source of inferredTypeSources) {
    const parent = source.node.parent;
    const signature = ts.isFunctionLike(parent) ? checker.getSignatureFromDeclaration(parent) : undefined;
    const type = signature ? checker.getReturnTypeOfSignature(signature) : checker.getTypeAtLocation(source.node);
    const namedTypes = new Set<ts.Symbol>();
    collectNamedTypes(type, namedTypes);
    const file = filesByPath.get(source.definition.filePath);
    if (!file) continue;
    for (const namedType of namedTypes) {
      const target = resolveDefinition(namedType);
      if (!target || target.id === source.definition.id) continue;
      const exists = file.references.some((reference) => reference.kind === "type" && reference.sourceSymbolId === source.definition.id && reference.targetSymbolId === target.id);
      if (!exists) file.references.push({ name: target.name, kind: "type", sourceSymbolId: source.definition.id, targetSymbolId: target.id, filePath: source.definition.filePath, line: source.definition.line, column: source.definition.column });
    }
  }
}

function isDeclarationName(node: ts.Identifier) {
  const parent = node.parent as ts.Node & { name?: ts.Node };
  return parent.name === node && (ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent));
}
