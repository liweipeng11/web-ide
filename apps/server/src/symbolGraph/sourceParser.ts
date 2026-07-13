import path from "node:path";
import ts from "typescript";
import type { ModuleDependency, ParsedImport, ParsedSourceFile, SymbolDefinition, SymbolKind, SymbolReference, SymbolReferenceKind } from "./types.js";

type ScriptSource = {
  content: string;
  lineOffset: number;
  charOffset: number;
  language: "ts" | "tsx" | "js" | "jsx";
  setup: boolean;
};

function getScriptSources(content: string, filePath: string): ScriptSource[] {
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== ".vue") {
    const language = extension === ".tsx" ? "tsx" : extension === ".jsx" ? "jsx" : [".js", ".mjs", ".cjs"].includes(extension) ? "js" : "ts";
    return [{ content, lineOffset: 0, charOffset: 0, language, setup: false }];
  }

  const scripts: ScriptSource[] = [];
  const expression = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(content))) {
    const contentStart = match.index + match[0].indexOf(match[2]);
    const language = /\blang=["']tsx["']/i.test(match[1]) ? "tsx" : /\blang=["'](?:ts|typescript)["']/i.test(match[1]) ? "ts" : "js";
    scripts.push({
      content: match[2],
      lineOffset: content.slice(0, contentStart).split(/\r?\n/).length - 1,
      charOffset: contentStart,
      language,
      setup: /(?:^|\s)setup(?:\s|=|$)/i.test(match[1])
    });
  }
  return scripts;
}

function scriptKind(language: ScriptSource["language"]) {
  if (language === "tsx") return ts.ScriptKind.TSX;
  if (language === "jsx") return ts.ScriptKind.JSX;
  if (language === "js") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function modifiersOf(node: ts.Node) {
  return ts.canHaveModifiers(node) ? ts.getModifiers(node) || [] : [];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return modifiersOf(node).some((modifier) => modifier.kind === kind);
}

function isComponentName(name: string, filePath: string) {
  return /^[A-Z]/.test(name) && /\.(?:tsx|jsx|vue)$/i.test(filePath);
}

function variableKind(node: ts.VariableDeclaration, filePath: string): SymbolKind {
  const name = ts.isIdentifier(node.name) ? node.name.text : "";
  if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return isComponentName(name, filePath) ? "component" : "function";
  if (node.initializer && ts.isCallExpression(node.initializer) && isComponentName(name, filePath) && /(?:^|\.)(?:memo|forwardRef|defineComponent)$/.test(node.initializer.expression.getText())) return "component";
  return node.parent.flags & ts.NodeFlags.Const ? "constant" : "variable";
}

function positionOf(sourceFile: ts.SourceFile, node: ts.Node, lineOffset: number) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1 + lineOffset, column: position.character + 1 };
}

function referenceKind(node: ts.Identifier): SymbolReferenceKind {
  if (ts.isExportSpecifier(node.parent)) return "export";
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) return "call";
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node && ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent) return "call";
  if (ts.isNewExpression(node.parent) && node.parent.expression === node) return "call";
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isStatement(current) && !ts.isSourceFile(current)) {
    if (ts.isTypeNode(current)) return "type";
    current = current.parent;
  }
  return "reference";
}

function isDeclarationIdentifier(node: ts.Identifier) {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent) || ts.isMethodDeclaration(parent)) return parent.name === node;
  return false;
}

function isImportIdentifier(node: ts.Identifier) {
  return ts.isImportClause(node.parent) || ts.isImportSpecifier(node.parent) || ts.isNamespaceImport(node.parent);
}

function nearestContainer(node: ts.Node, symbolByNode: Map<ts.Node, SymbolDefinition>) {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    const symbol = symbolByNode.get(current);
    if (symbol) return symbol.id;
    current = current.parent;
  }
  return undefined;
}

function parseScript(filePath: string, script: ScriptSource): ParsedSourceFile {
  const sourceFile = ts.createSourceFile(filePath, script.content, ts.ScriptTarget.Latest, true, scriptKind(script.language));
  const result: ParsedSourceFile = { filePath, symbols: [], references: [], imports: [], exports: [], dependencies: [] };
  const symbolByNode = new Map<ts.Node, SymbolDefinition>();

  function addSymbol(node: ts.Node, name: string, kind: SymbolKind, nameNode: ts.Node = node, containerName?: string) {
    const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword) || (ts.isVariableDeclaration(node) && hasModifier(node.parent.parent, ts.SyntaxKind.ExportKeyword));
    const defaultExport = hasModifier(node, ts.SyntaxKind.DefaultKeyword) || (ts.isVariableDeclaration(node) && hasModifier(node.parent.parent, ts.SyntaxKind.DefaultKeyword));
    const symbol: SymbolDefinition = {
      id: `${filePath}#${name}@${nameNode.getStart(sourceFile) + script.charOffset}`,
      name,
      kind,
      exported,
      defaultExport,
      containerName,
      filePath,
      ...positionOf(sourceFile, nameNode, script.lineOffset)
    };
    result.symbols.push(symbol);
    symbolByNode.set(node, symbol);
  }

  function collectDefinitions(node: ts.Node, containerName?: string) {
    if (ts.isFunctionDeclaration(node)) addSymbol(node, node.name?.text || "default", node.name && isComponentName(node.name.text, filePath) ? "component" : "function", node.name || node, containerName);
    else if (ts.isClassDeclaration(node)) addSymbol(node, node.name?.text || "default", "class", node.name || node, containerName);
    else if (ts.isInterfaceDeclaration(node)) addSymbol(node, node.name.text, "interface", node.name, containerName);
    else if (ts.isTypeAliasDeclaration(node)) addSymbol(node, node.name.text, "type", node.name, containerName);
    else if (ts.isEnumDeclaration(node)) addSymbol(node, node.name.text, "enum", node.name, containerName);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) addSymbol(node, node.name.text, variableKind(node, filePath), node.name, containerName);
    else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) addSymbol(node, node.name.text, "method", node.name, containerName);
    const ownSymbol = symbolByNode.get(node);
    ts.forEachChild(node, (child) => collectDefinitions(child, ownSymbol?.name || containerName));
  }
  collectDefinitions(sourceFile);

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      if (ts.isIdentifier(statement.expression)) {
        const localName = statement.expression.text;
        const target = result.symbols.find((symbol) => symbol.name === localName);
        if (target) {
          target.exported = true;
          target.defaultExport = true;
        }
      } else if (/\.vue$/i.test(filePath)) {
        const name = statement.expression.getText(sourceFile).match(/\bname\s*:\s*["'`]([A-Za-z_$][\w$-]*)["'`]/)?.[1] || path.basename(filePath, ".vue");
        addSymbol(statement, name, "component");
        const target = result.symbols.at(-1)!;
        target.exported = true;
        target.defaultExport = true;
      } else if (ts.isArrowFunction(statement.expression) || ts.isFunctionExpression(statement.expression) || ts.isClassExpression(statement.expression)) {
        const name = path.basename(filePath, path.extname(filePath));
        const kind: SymbolKind = ts.isClassExpression(statement.expression) ? "class" : isComponentName(name, filePath) ? "component" : "function";
        addSymbol(statement, name, kind);
        const target = result.symbols.at(-1)!;
        target.exported = true;
        target.defaultExport = true;
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      const importedNames: string[] = [];
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const localName = element.propertyName?.text || element.name.text;
          if (moduleSpecifier) {
            importedNames.push(localName);
            result.imports.push({ localName: element.name.text, importedName: localName, moduleSpecifier, reExport: true, ...positionOf(sourceFile, element.name, script.lineOffset) });
          } else {
            result.exports.push({ exportedName: element.name.text, localName });
            const target = result.symbols.find((symbol) => symbol.name === localName);
            if (target) target.exported = true;
          }
        }
      } else if (moduleSpecifier) {
        result.imports.push({ localName: "*", importedName: "*", moduleSpecifier, reExport: true, namespaceImport: true, ...positionOf(sourceFile, statement, script.lineOffset) });
      }
      if (moduleSpecifier) result.dependencies.push({ fromFile: filePath, specifier: moduleSpecifier, importedNames });
      continue;
    }

    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    const importedNames: string[] = [];
    const clause = statement.importClause;
    if (clause?.name) {
      importedNames.push("default");
      result.imports.push({ localName: clause.name.text, importedName: "default", moduleSpecifier, ...positionOf(sourceFile, clause.name, script.lineOffset) });
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const importedName = element.propertyName?.text || element.name.text;
        importedNames.push(importedName);
        result.imports.push({ localName: element.name.text, importedName, moduleSpecifier, ...positionOf(sourceFile, element.name, script.lineOffset) });
      }
    } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      result.imports.push({ localName: clause.namedBindings.name.text, importedName: "*", moduleSpecifier, namespaceImport: true, ...positionOf(sourceFile, clause.namedBindings.name, script.lineOffset) });
    }
    result.dependencies.push({ fromFile: filePath, specifier: moduleSpecifier, importedNames });
  }

  function collectReferences(node: ts.Node) {
    if (ts.isIdentifier(node) && !isDeclarationIdentifier(node) && !isImportIdentifier(node)) {
      const isPropertyName = ts.isPropertyAssignment(node.parent) && node.parent.name === node;
      if (!isPropertyName) result.references.push({ name: node.text, kind: referenceKind(node), sourceSymbolId: nearestContainer(node, symbolByNode), filePath, ...positionOf(sourceFile, node, script.lineOffset) });
    }
    ts.forEachChild(node, collectReferences);
  }
  collectReferences(sourceFile);
  return result;
}

/** 使用 TypeScript AST 提取单文件声明、导入和符号使用，并兼容 Vue 多脚本区块。 */
export function parseSourceFile(content: string, filePath: string): ParsedSourceFile {
  const scripts = getScriptSources(content, filePath);
  const result: ParsedSourceFile = { filePath, symbols: [], references: [], imports: [], exports: [], dependencies: [] };
  for (const script of scripts) {
    const parsed = parseScript(filePath, script);
    result.symbols.push(...parsed.symbols);
    result.references.push(...parsed.references);
    result.imports.push(...parsed.imports);
    result.exports.push(...parsed.exports);
    result.dependencies.push(...parsed.dependencies);
  }

  if (/\.vue$/i.test(filePath) && scripts.some((script) => script.setup) && !result.symbols.some((symbol) => symbol.kind === "component")) {
    const setup = scripts.find((script) => script.setup)!;
    const name = path.basename(filePath, ".vue");
    result.symbols.unshift({ id: `${filePath}#${name}@${setup.charOffset}`, name, kind: "component", exported: true, defaultExport: true, filePath, line: setup.lineOffset + 1, column: 1 });
  }
  if (/\.vue$/i.test(filePath)) {
    const template = /<template\b[^>]*>([\s\S]*?)<\/template>/i.exec(content);
    if (template) {
      const templateOffset = template.index + template[0].indexOf(template[1]);
      const tagExpression = /<([A-Z][\w$.-]*|[a-z][\w$-]*-[\w$-]+)\b/g;
      let tag: RegExpExecArray | null;
      while ((tag = tagExpression.exec(template[1]))) {
        const rawName = tag[1];
        const name = rawName.includes("-") ? rawName.split("-").filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("") : rawName;
        const absoluteOffset = templateOffset + tag.index + 1;
        const prefix = content.slice(0, absoluteOffset);
        const lines = prefix.split(/\r?\n/);
        result.references.push({ name, kind: "reference", filePath, line: lines.length, column: lines.at(-1)!.length + 1 });
      }
    }
  }
  return result;
}
