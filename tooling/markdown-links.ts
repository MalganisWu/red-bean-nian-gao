import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface MarkdownDocument {
  readonly anchors: ReadonlySet<string>;
  readonly references: ReadonlyMap<string, string>;
  readonly referenceUses: readonly string[];
  readonly links: readonly string[];
}

export interface MarkdownCheckResult {
  readonly fileCount: number;
  readonly linkCount: number;
  readonly issues: readonly string[];
}

interface FenceMarker {
  readonly marker: "`" | "~";
  readonly length: number;
}

const ATX_HEADING = /^ {0,3}#{1,6}[\t ]+(.+?)[\t ]*#*[\t ]*$/;
const SETEXT_HEADING = /^ {0,3}(?:=+|-+)[\t ]*$/;
const INLINE_LINK = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[([^\]]+)\]:[\t ]*(.+)$/;
const REFERENCE_USE = /!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
const HTML_LINK = /(?:href|src)[\t ]*=[\t ]*["']([^"']+)["']/gi;
const HTML_ANCHOR = /(?:id|name)[\t ]*=[\t ]*["']([^"']+)["']/gi;
const HTML_TAG = /<[^>]+>/g;
const MARKDOWN_LINK = /!?\[([^\]]+)\]\([^)]+\)/g;
const CODE_SPAN = /`+([^`]+)`+/g;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(
    /&(?:#\d+|#x[\da-f]+|[a-z]+);/gi,
    (entity: string): string => {
      const name = entity.slice(1, -1);
      const known = named[name.toLowerCase()];
      if (known !== undefined) return known;
      const numeric =
        name.startsWith("#x") || name.startsWith("#X")
          ? Number.parseInt(name.slice(2), 16)
          : name.startsWith("#")
            ? Number.parseInt(name.slice(1), 10)
            : Number.NaN;
      if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 0x10ffff) {
        return entity;
      }
      try {
        return String.fromCodePoint(numeric);
      } catch (_cause: unknown) {
        return entity;
      }
    },
  );
}

function capture(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

function fenceMarker(line: string): FenceMarker | undefined {
  const leading = /^[ \t]*/.exec(line)?.[0] ?? "";
  if (leading.length > 3) return undefined;
  const trimmed = line.slice(leading.length);
  const first = trimmed[0];
  if (first !== "`" && first !== "~") return undefined;
  let length = 0;
  while (trimmed[length] === first) length += 1;
  return length >= 3 ? { marker: first, length } : undefined;
}

function normalizeReference(value: string): string {
  return value.trim().split(/\s+/).join(" ").toLowerCase();
}

function markdownDestination(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    if (end >= 0) return decodeHtmlEntities(trimmed.slice(1, end));
  }
  const escapedSpaces = trimmed.replace(/\\ /g, "\u0000");
  const first = escapedSpaces.split(/\s+/)[0] ?? "";
  return decodeHtmlEntities(first.split("\u0000").join(" "));
}

export function headingSlug(value: string): string {
  const normalized = decodeHtmlEntities(value)
    .replace(MARKDOWN_LINK, "$1")
    .replace(CODE_SPAN, "$1")
    .replace(HTML_TAG, "")
    .trim()
    .toLowerCase();
  let slug = "";
  for (const character of normalized) {
    if (/^[\p{L}\p{N}_-]$/u.test(character)) slug += character;
    else if (/^\s$/u.test(character)) slug += "-";
  }
  return slug;
}

function addHeadingAnchor(
  anchors: Set<string>,
  counts: Map<string, number>,
  heading: string,
): void {
  let slug = headingSlug(heading);
  if (slug.length === 0) return;
  const count = counts.get(slug) ?? 0;
  counts.set(slug, count + 1);
  if (count > 0) slug = `${slug}-${count}`;
  anchors.add(slug);
}

export function parseMarkdownDocument(content: string): MarkdownDocument {
  const anchors = new Set<string>();
  const references = new Map<string, string>();
  const referenceUses: string[] = [];
  const links: string[] = [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const slugCounts = new Map<string, number>();
  let activeFence: FenceMarker | undefined;

  for (const [index, line] of lines.entries()) {
    const fence = fenceMarker(line);
    if (fence) {
      if (activeFence === undefined) activeFence = fence;
      else if (
        fence.marker === activeFence.marker &&
        fence.length >= activeFence.length
      ) {
        activeFence = undefined;
      }
      continue;
    }
    if (activeFence !== undefined) continue;

    for (const match of line.matchAll(HTML_ANCHOR)) {
      anchors.add(decodeHtmlEntities(capture(match, 1)));
    }
    const atx = ATX_HEADING.exec(line);
    if (atx) addHeadingAnchor(anchors, slugCounts, capture(atx, 1));
    else if (index > 0 && SETEXT_HEADING.test(line)) {
      addHeadingAnchor(anchors, slugCounts, lines[index - 1] ?? "");
    }

    const definition = REFERENCE_DEFINITION.exec(line);
    if (definition && !capture(definition, 1).startsWith("^")) {
      const target = markdownDestination(capture(definition, 2));
      references.set(normalizeReference(capture(definition, 1)), target);
      if (target.length > 0) links.push(target);
      continue;
    }
    for (const match of line.matchAll(REFERENCE_USE)) {
      const label = capture(match, 1);
      const reference = capture(match, 2) || label;
      if (!reference.startsWith("^")) referenceUses.push(reference);
    }
    for (const match of line.matchAll(INLINE_LINK)) {
      const target = markdownDestination(capture(match, 1));
      if (target.length > 0) links.push(target);
    }
    for (const match of line.matchAll(HTML_LINK)) {
      links.push(decodeHtmlEntities(capture(match, 1).trim()));
    }
  }
  return { anchors, references, referenceUses, links };
}

function markdownFiles(root: string): readonly string[] {
  const output = execFileSync(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { encoding: "buffer", maxBuffer: 16 * 1_048_576 },
  );
  return output
    .toString("utf8")
    .split("\0")
    .filter(
      (name: string): boolean => path.extname(name).toLowerCase() === ".md",
    )
    .map((name: string): string => path.resolve(root, name))
    .sort();
}

export class MarkdownLinkChecker {
  readonly #root: string;
  readonly #documents = new Map<string, MarkdownDocument>();
  readonly #issues = new Set<string>();
  #linkCount = 0;

  public constructor(root: string) {
    this.#root = path.resolve(root);
  }

  public get issues(): readonly string[] {
    return [...this.#issues].sort();
  }

  public async checkRepository(): Promise<MarkdownCheckResult> {
    const files = markdownFiles(this.#root);
    for (const file of files) {
      let document: MarkdownDocument;
      try {
        document = await this.loadDocument(file);
      } catch (cause: unknown) {
        this.addIssue(file, `读取失败：${normalizeError(cause).message}`);
        continue;
      }
      for (const reference of document.referenceUses) {
        if (!document.references.has(normalizeReference(reference))) {
          this.addIssue(file, `引用式链接未定义：[${reference}]`);
        }
      }
      for (const target of document.links) {
        this.#linkCount += 1;
        await this.checkTarget(file, target);
      }
    }
    return {
      fileCount: files.length,
      linkCount: this.#linkCount,
      issues: this.issues,
    };
  }

  public async checkTarget(source: string, rawTarget: string): Promise<void> {
    const target = rawTarget.trim();
    if (
      target.length === 0 ||
      target.startsWith("//") ||
      target.startsWith("/") ||
      SCHEME.test(target) ||
      target.includes("{{") ||
      target.includes("}}")
    ) {
      return;
    }
    const separator = target.indexOf("#");
    let pathPart = separator >= 0 ? target.slice(0, separator) : target;
    const fragment = separator >= 0 ? target.slice(separator + 1) : "";
    const query = pathPart.indexOf("?");
    if (query >= 0) pathPart = pathPart.slice(0, query);

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathPart);
    } catch (_cause: unknown) {
      this.addIssue(source, `链接路径编码无效：${rawTarget}`);
      return;
    }
    let resolved =
      decodedPath.length === 0
        ? path.resolve(source)
        : path.resolve(path.dirname(source), decodedPath);
    let information;
    try {
      information = await stat(resolved);
    } catch (_cause: unknown) {
      this.addIssue(source, `失效本地链接：${rawTarget}`);
      return;
    }
    if (information.isDirectory() && fragment.length > 0) {
      resolved = path.join(resolved, "README.md");
      try {
        await stat(resolved);
      } catch (_cause: unknown) {
        this.addIssue(source, `目录链接没有可检查锚点的 README：${rawTarget}`);
        return;
      }
    }
    if (
      fragment.length === 0 ||
      path.extname(resolved).toLowerCase() !== ".md"
    ) {
      return;
    }
    let decodedFragment: string;
    try {
      decodedFragment = decodeURIComponent(fragment);
    } catch (_cause: unknown) {
      this.addIssue(source, `锚点编码无效：${rawTarget}`);
      return;
    }
    const document = await this.loadDocument(resolved);
    const anchor = decodedFragment.startsWith("user-content-")
      ? decodedFragment.slice("user-content-".length)
      : decodedFragment;
    if (!document.anchors.has(anchor)) {
      this.addIssue(source, `Markdown 锚点不存在：${rawTarget}`);
    }
  }

  private async loadDocument(file: string): Promise<MarkdownDocument> {
    const normalized = path.resolve(file);
    const cached = this.#documents.get(normalized);
    if (cached) return cached;
    const document = parseMarkdownDocument(await readFile(normalized, "utf8"));
    this.#documents.set(normalized, document);
    return document;
  }

  private addIssue(file: string, message: string): void {
    this.#issues.add(
      `${path.relative(this.#root, file).split(path.sep).join("/")}: ${message}`,
    );
  }
}

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function checkMarkdownLinks(
  root: string,
): Promise<MarkdownCheckResult> {
  return new MarkdownLinkChecker(root).checkRepository();
}

async function main(): Promise<void> {
  const root = process.argv[2] ?? ".";
  const result = await checkMarkdownLinks(root);
  if (result.issues.length > 0) {
    for (const issue of result.issues) process.stderr.write(`✗ ${issue}\n`);
    throw new Error(`Markdown 链接检查失败：${result.issues.length} 个问题。`);
  }
  process.stdout.write(
    `Markdown 链接检查通过：${result.fileCount} 个文件，${result.linkCount} 个本地链接/资源。\n`,
  );
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  path.resolve(entry) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (cause: unknown) {
    process.stderr.write(`${normalizeError(cause).message}\n`);
    process.exitCode = 1;
  }
}
