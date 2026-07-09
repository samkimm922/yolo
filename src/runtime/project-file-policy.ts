function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeRepoFilePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function cleanPattern(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function declarationNodes(source) {
  if (!isObject(source)) return [];
  return [
    source,
    source.config,
    source.prd,
    source.project,
    source.build,
    source.scope,
    source.file_policy,
    source.filePolicy,
    source.config?.project,
    source.config?.build,
    source.config?.file_policy,
    source.config?.filePolicy,
    source.prd?.project,
    source.prd?.file_policy,
    source.prd?.filePolicy,
  ].filter(isObject);
}

function declaredPatterns(sources, keys) {
  const patterns = [];
  for (const source of sources) {
    if (Array.isArray(source)) {
      patterns.push(...source.map(cleanPattern));
      continue;
    }
    for (const node of declarationNodes(source)) {
      for (const key of keys) {
        patterns.push(...asArray(node[key]).map(cleanPattern));
      }
    }
  }
  return unique(patterns);
}

export function declaredBusinessFilePatterns(...sources) {
  return declaredPatterns(sources, [
    "business_file_patterns",
    "businessFilePatterns",
    "business_file_globs",
    "businessFileGlobs",
    "business_globs",
    "businessGlobs",
  ]);
}

export function declaredConfigFilePatterns(...sources) {
  return declaredPatterns(sources, [
    "config_file_patterns",
    "configFilePatterns",
    "pure_config_file_patterns",
    "pureConfigFilePatterns",
  ]);
}

function escapeRegexChar(char) {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(glob) {
  const normalized = normalizeRepoFilePath(glob).replace(/^\/+/, "");
  const pattern = normalized.endsWith("/") ? `${normalized}**` : normalized;
  let source = "^";
  for (let i = 0; i < pattern.length;) {
    if (pattern.slice(i, i + 3) === "**/") {
      source += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (pattern.slice(i, i + 2) === "**") {
      source += ".*";
      i += 2;
      continue;
    }
    const char = pattern[i];
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += escapeRegexChar(char);
    i++;
  }
  return new RegExp(`${source}$`);
}

function patternToRegExp(pattern) {
  const normalized = cleanPattern(pattern);
  if (/^\.[^/*?]+$/.test(normalized)) return new RegExp(`${escapeRegexChar(normalized)}$`, "i");
  return globToRegExp(normalized);
}

export function matchesAnyFilePattern(filePath, patterns = []) {
  const normalized = normalizeRepoFilePath(filePath);
  return patterns.some((pattern) => patternToRegExp(pattern).test(normalized));
}
