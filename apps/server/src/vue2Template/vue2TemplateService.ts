import { HttpError } from "../errors.js";
import type { Vue2TemplateFragment } from "./types.js";

interface ScriptBlock {
  start: number;
  end: number;
  openTagEnd: number;
  closeTagStart: number;
  content: string;
}

interface ObjectRange {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
}

interface ObjectProperty {
  key: string;
  start: number;
  end: number;
  code: string;
}

const objectSectionNames = new Set(["methods", "computed", "watch", "props", "components", "filters"]);
const replaceSectionNames = new Set(["mixins", "model"]);
const hookSectionNames = new Set([
  "created",
  "mounted",
  "beforeCreate",
  "beforeMount",
  "beforeUpdate",
  "updated",
  "activated",
  "deactivated",
  "beforeDestroy",
  "destroyed",
  "errorCaptured",
  "serverPrefetch",
  "beforeRouteEnter"
]);

function stripWrapperCode(code: string, section: string) {
  const trimmed = code.trim();
  const propertyMatch = new RegExp(`^${section}\\s*:\\s*([\\s\\S]*)$`).exec(trimmed);
  if (propertyMatch) {
    const propertyBody = propertyMatch[1].trim();
    if (propertyBody.startsWith("{")) {
      const closeIndex = findClosingBracket(propertyBody, 0, "{", "}");
      if (closeIndex === propertyBody.length - 1) {
        return propertyBody.slice(1, closeIndex).trim();
      }
    }

    return propertyBody;
  }

  const methodMatch = new RegExp(`^${section}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*\\}$`).exec(trimmed);
  return methodMatch ? trimmed : code.trim();
}

function stripTopLevelPropertyWrapper(code: string, section: string) {
  const trimmed = code.trim();
  const propertyMatch = new RegExp(`^${section}\\s*:\\s*([\\s\\S]*)$`).exec(trimmed);
  return propertyMatch ? propertyMatch[1].trim() : trimmed;
}

function findClosingBracket(source: string, openIndex: number, openChar: string, closeChar: string) {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index] || "";
    const next = source[index + 1] || "";

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }

    if (char === openChar) depth += 1;
    if (char === closeChar) depth -= 1;
    if (depth === 0) return index;
  }

  return -1;
}

function findScriptBlock(template: string): ScriptBlock {
  const scriptMatch = /<script(?!\s+setup\b)[^>]*>/i.exec(template);
  if (!scriptMatch || scriptMatch.index === undefined) {
    throw new HttpError(400, "No script tag found in Vue component");
  }

  const closeTagMatch = /<\/script>/i.exec(template.slice(scriptMatch.index + scriptMatch[0].length));
  if (!closeTagMatch || closeTagMatch.index === undefined) {
    throw new HttpError(400, "No closing script tag found in Vue component");
  }

  const openTagEnd = scriptMatch.index + scriptMatch[0].length;
  const closeTagStart = openTagEnd + closeTagMatch.index;

  return {
    start: scriptMatch.index,
    end: closeTagStart + closeTagMatch[0].length,
    openTagEnd,
    closeTagStart,
    content: template.slice(openTagEnd, closeTagStart)
  };
}

function findExportDefaultObject(script: string): ObjectRange {
  const exportMatch = /export\s+default\s*/.exec(script);
  if (!exportMatch || exportMatch.index === undefined) {
    throw new HttpError(400, "No export default found in Vue component script");
  }

  const objectStart = script.indexOf("{", exportMatch.index + exportMatch[0].length);
  const objectEnd = objectStart >= 0 ? findClosingBracket(script, objectStart, "{", "}") : -1;

  if (objectStart < 0 || objectEnd < 0) {
    throw new HttpError(400, "Failed to parse export default object");
  }

  return {
    start: objectStart,
    end: objectEnd,
    bodyStart: objectStart + 1,
    bodyEnd: objectEnd
  };
}

function getPropertyKey(code: string) {
  const trimmed = code.trim();
  const methodMatch = /^([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed);
  if (methodMatch) return methodMatch[1];

  const pairMatch = /^([A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:/.exec(trimmed);
  if (!pairMatch) return "";

  return pairMatch[1].replace(/^['"]|['"]$/g, "");
}

function splitTopLevelProperties(body: string): ObjectProperty[] {
  const properties: ObjectProperty[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index <= body.length; index += 1) {
    const char = body[index] || "";
    const next = body[index + 1] || "";

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;

    if ((char === "," && depth === 0) || index === body.length) {
      const code = body.slice(start, index);
      const leftTrimmed = code.replace(/^\s+/, "");
      const trimmedStart = start + code.length - leftTrimmed.length;
      const key = getPropertyKey(leftTrimmed);

      if (key) {
        properties.push({
          key,
          start: trimmedStart,
          end: index,
          code: leftTrimmed.trim()
        });
      }

      start = index + 1;
    }
  }

  return properties;
}

function replaceRange(source: string, start: number, end: number, replacement: string) {
  return source.slice(0, start) + replacement + source.slice(end);
}

function validateFragmentCode(section: string, code: string) {
  if (section === "template") return;

  const trimmed = code.trim();
  const candidates =
    section === "data"
      ? [`({ ${trimmed} })`, `({ data() { return { ${trimmed} } } })`]
      : [`({ ${trimmed} })`, `({ ${section}: { ${stripWrapperCode(trimmed, section)} } })`];

  if (candidates.some((candidate) => {
    try {
      new Function(`return ${candidate};`);
      return true;
    } catch {
      return false;
    }
  })) {
    return;
  }

  throw new HttpError(400, `Failed to parse replacement code for section '${section}'.`);
}

function formatObjectProperty(section: string, body: string) {
  return `${section}: {\n${indentCode(body.trim(), 4)}\n  }`;
}

function indentCode(code: string, spaces: number) {
  const indent = " ".repeat(spaces);
  return code
    .split(/\r?\n/)
    .map((line) => (line.trim() ? indent + line : line))
    .join("\n");
}

function appendTopLevelProperty(script: string, objectRange: ObjectRange, propertyCode: string) {
  const body = script.slice(objectRange.bodyStart, objectRange.bodyEnd);
  const trimmedBody = body.trim();
  const prefix = trimmedBody ? ",\n  " : "\n  ";
  const suffix = trimmedBody ? "" : "\n";

  return replaceRange(script, objectRange.bodyEnd, objectRange.bodyEnd, `${prefix}${propertyCode}${suffix}`);
}

function replaceTopLevelProperty(script: string, objectRange: ObjectRange, property: ObjectProperty, propertyCode: string) {
  return replaceRange(script, objectRange.bodyStart + property.start, objectRange.bodyStart + property.end, propertyCode);
}

function mergeObjectSection(script: string, objectRange: ObjectRange, section: string, code: string) {
  const properties = splitTopLevelProperties(script.slice(objectRange.bodyStart, objectRange.bodyEnd));
  const property = properties.find((item) => item.key === section);
  const rawBody = stripWrapperCode(code, section);
  const fullProperty = formatObjectProperty(section, rawBody);

  if (!property) {
    return appendTopLevelProperty(script, objectRange, fullProperty);
  }

  const openIndex = property.code.indexOf("{");
  const closeIndex = openIndex >= 0 ? findClosingBracket(property.code, openIndex, "{", "}") : -1;
  if (openIndex < 0 || closeIndex < 0) {
    return replaceTopLevelProperty(script, objectRange, property, fullProperty);
  }

  const currentBody = property.code.slice(openIndex + 1, closeIndex);
  const mergedBody = mergePropertyBodies(currentBody, rawBody);
  const nextPropertyCode = `${section}: {\n${indentCode(mergedBody.trim(), 4)}\n  }`;
  return replaceTopLevelProperty(script, objectRange, property, nextPropertyCode);
}

function mergePropertyBodies(currentBody: string, nextBody: string) {
  let mergedBody = currentBody;

  for (const nextProperty of splitTopLevelProperties(nextBody)) {
    // 每次替换后重新计算顶层属性位置，避免前一次替换改变后续坐标。
    const currentProperties = splitTopLevelProperties(mergedBody);
    const existing = currentProperties.find((item) => item.key === nextProperty.key);
    if (!existing) {
      const trimmedBody = mergedBody.trim();
      mergedBody = `${trimmedBody}${trimmedBody ? ",\n" : ""}${nextProperty.code}`;
      continue;
    }

    mergedBody = replaceRange(mergedBody, existing.start, existing.end, nextProperty.code);
  }

  return mergedBody;
}

function normalizeHookProperty(section: string, code: string) {
  const trimmed = code.trim();
  if (new RegExp(`^${section}\\s*\\(`).test(trimmed) || new RegExp(`^${section}\\s*:`).test(trimmed)) {
    return trimmed;
  }

  return `${section}() {\n${indentCode(trimmed, 4)}\n  }`;
}

function mergeDataSection(script: string, objectRange: ObjectRange, code: string) {
  const properties = splitTopLevelProperties(script.slice(objectRange.bodyStart, objectRange.bodyEnd));
  const property = properties.find((item) => item.key === "data");
  const trimmed = code.trim();

  if (/^data\s*[:(]/.test(trimmed)) {
    return property ? replaceTopLevelProperty(script, objectRange, property, trimmed) : appendTopLevelProperty(script, objectRange, trimmed);
  }

  if (!property) {
    return appendTopLevelProperty(script, objectRange, `data() {\n    return {\n${indentCode(trimmed, 6)}\n    };\n  }`);
  }

  const returnMatch = /return\s*\{/.exec(property.code);
  if (!returnMatch || returnMatch.index === undefined) {
    return replaceTopLevelProperty(script, objectRange, property, `data() {\n    return {\n${indentCode(trimmed, 6)}\n    };\n  }`);
  }

  const objectStart = property.code.indexOf("{", returnMatch.index);
  const objectEnd = objectStart >= 0 ? findClosingBracket(property.code, objectStart, "{", "}") : -1;
  if (objectStart < 0 || objectEnd < 0) {
    throw new HttpError(400, "Failed to parse data return object");
  }

  const currentBody = property.code.slice(objectStart + 1, objectEnd);
  const mergedBody = mergePropertyBodies(currentBody, trimmed);
  const nextPropertyCode = replaceRange(property.code, objectStart + 1, objectEnd, `\n${indentCode(mergedBody.trim(), 6)}\n    `);
  return replaceTopLevelProperty(script, objectRange, property, nextPropertyCode);
}

function applyScriptFragment(script: string, fragment: Vue2TemplateFragment) {
  validateFragmentCode(fragment.section, fragment.code);
  const objectRange = findExportDefaultObject(script);
  const properties = splitTopLevelProperties(script.slice(objectRange.bodyStart, objectRange.bodyEnd));
  const property = properties.find((item) => item.key === fragment.section);

  if (fragment.section === "data") {
    return mergeDataSection(script, objectRange, fragment.code);
  }

  if (objectSectionNames.has(fragment.section)) {
    return mergeObjectSection(script, objectRange, fragment.section, fragment.code);
  }

  if (replaceSectionNames.has(fragment.section)) {
    const body = stripTopLevelPropertyWrapper(fragment.code, fragment.section);
    const propertyCode = `${fragment.section}: ${body}`;
    return property ? replaceTopLevelProperty(script, objectRange, property, propertyCode) : appendTopLevelProperty(script, objectRange, propertyCode);
  }

  if (hookSectionNames.has(fragment.section)) {
    const propertyCode = normalizeHookProperty(fragment.section, fragment.code);
    return property ? replaceTopLevelProperty(script, objectRange, property, propertyCode) : appendTopLevelProperty(script, objectRange, propertyCode);
  }

  const propertyCode = `${fragment.section}: ${stripTopLevelPropertyWrapper(fragment.code, fragment.section)}`;
  return property ? replaceTopLevelProperty(script, objectRange, property, propertyCode) : appendTopLevelProperty(script, objectRange, propertyCode);
}

function replaceTemplateBlock(source: string, code: string) {
  const templateMatch = /<template[^>]*>/i.exec(source);
  if (!templateMatch || templateMatch.index === undefined) {
    throw new HttpError(400, "No template tag found in Vue component");
  }

  const closeMatch = /<\/template>/i.exec(source.slice(templateMatch.index + templateMatch[0].length));
  if (!closeMatch || closeMatch.index === undefined) {
    throw new HttpError(400, "No closing template tag found in Vue component");
  }

  const bodyStart = templateMatch.index + templateMatch[0].length;
  const bodyEnd = bodyStart + closeMatch.index;
  return replaceRange(source, bodyStart, bodyEnd, `\n${indentCode(code.trim(), 2)}\n`);
}

export function applyVue2TemplateFragments(template: string, fragments: Vue2TemplateFragment[]) {
  return fragments.reduce((currentTemplate, fragment) => {
    if (fragment.section === "template") {
      return replaceTemplateBlock(currentTemplate, fragment.code);
    }

    const scriptBlock = findScriptBlock(currentTemplate);
    const nextScript = applyScriptFragment(scriptBlock.content, fragment);
    return replaceRange(currentTemplate, scriptBlock.openTagEnd, scriptBlock.closeTagStart, nextScript);
  }, template);
}
