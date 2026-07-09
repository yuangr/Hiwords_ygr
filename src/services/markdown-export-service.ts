import { App, TFile, Notice, normalizePath } from 'obsidian';
import type { HiWordsSettings } from '../utils/types';

export class MarkdownExportService {
    private app: App;
    private settings: HiWordsSettings;

    constructor(app: App, settings: HiWordsSettings) {
        this.app = app;
        this.settings = settings;
    }

    updateSettings(settings: HiWordsSettings) {
        this.settings = settings;
    }

    /**
     * Parsing the "Format:" section from the custom prompt to extract property keys.
     * Assumes keys are listed as "1) Key", "2) Key", etc.
     */
    private extractPropertyKeys(prompt: string): string[] {
        const formatIndex = prompt.toLowerCase().indexOf('format:');
        if (formatIndex === -1) return [];

        const formatSection = prompt.substring(formatIndex + 7);
        const lines = formatSection.split('\n');
        const keys: string[] = [];

        // Regex to match "1) Key" or "1. Key"
        const keyRegex = /^\s*\d+[\)\.]\s*(.+?)\s*$/;

        for (const line of lines) {
            const match = line.match(keyRegex);
            if (match && match[1]) {
                keys.push(match[1].trim());
            }
        }
        return keys;
    }

    /**
     * Parses the AI definition response to extract values corresponding to the keys.
     * Strategies:
     * 1. Split by keys if the AI includes them (e.g., "Key: Value").
     * 2. Split by numbered list markers (e.g., "1)", "2)") if keys are missing.
     */
    private extractPropertyValues(definition: string, keys: string[]): Record<string, string> {
        const values: Record<string, string> = {};
        if (keys.length === 0) return values;

        // Clean definition string
        let cleanDef = definition.trim();

        // FIX: Ignore introductory text (e.g. "Here's a concise definition...")
        // Find the index of the first numbered marker matching our pattern
        // Pattern: (Start or Newline) + Space* + Number + ) or .

        // We look for the first match of the split regex
        const splitRegex = /(?:^|\n)\s*\d+[\)\.]\s*/;
        const firstMatch = cleanDef.match(splitRegex);

        if (firstMatch && firstMatch.index !== undefined) {
            // If found, slice from the start of the match
            // Note: match.index is the start of the match, which might include \n
            // We want to keep the marker for the split logic below to work if it relies on having markers?
            // Actually, checks below: "parts = cleanDef.split(splitRegex)"
            // split will consume the markers. 
            // If we have introductory text, the first part of split result will be the intro text.
            // We can just drop the first part if it doesn't look like a property value?
            // BUT, if intro text exists, split might produce: ["Intro", "Value1", "Value2"...]
            // If NO intro text (starts with "1)"), split produces: ["", "Value1", "Value2"...] (empty string at start because match is at index 0)

            // Improved Strategy:
            // 1. Find start of first marker.
            // 2. Discard everything before it.
            cleanDef = cleanDef.substring(firstMatch.index).trim();
        }

        const parts = cleanDef.split(splitRegex).filter(p => p.trim().length > 0);

        // If we got roughly the same number of parts as keys, map them one-to-one
        // Note: parts might contain the property text itself like "词性: 动词"

        for (let i = 0; i < Math.min(keys.length, parts.length); i++) {
            const key = keys[i];
            let value = parts[i];

            // Sanitize value: remove the key if it repeats
            // Check if value starts with "Key:" or "Key：" or just "Key"
            // Escape key first, then add optional colon
            const keyPrefixRegex = new RegExp(`^\\s*${this.escapeRegExp(key)}[:：]?\\s*`, 'i');
            value = value.replace(keyPrefixRegex, '');

            values[key] = this.normalizeValue(value);
        }

        return values;
    }

    /**
     * Normalizes property value by removing common indentation for multiline text.
     */
    private normalizeValue(value: string): string {
        const lines = value.split('\n');

        // Note: split might produce empty leading/trailing lines if value starts/ends with \n

        // 1. Remove empty start lines to find the first real content
        let start = 0;
        while (start < lines.length && lines[start].trim().length === 0) {
            start++;
        }

        // If all empty
        if (start >= lines.length) return '';

        // 2. Remove empty end lines
        let end = lines.length - 1;
        while (end >= start && lines[end].trim().length === 0) {
            end--;
        }

        const contentLines = lines.slice(start, end + 1);
        if (contentLines.length === 0) return '';

        // 3. Detect common indentation
        // We only check lines that are NOT empty to determine min indentation
        let minIndent = Infinity;

        for (const line of contentLines) {
            if (line.trim().length > 0) {
                const match = line.match(/^(\s*)/);
                if (match) {
                    minIndent = Math.min(minIndent, match[1].length);
                }
            }
        }

        if (minIndent === Infinity) minIndent = 0;

        // 4. Remove indentation
        const normalizedLines = contentLines.map(line => {
            // CAREFUL: trimRight() but keep left relative indent?
            // No, we want to remove exactly minIndent from left.
            // But if line is empty (whitespace only) and length < minIndent, just empty it.
            if (line.trim().length === 0) return '';
            return line.substring(minIndent);
        });

        return normalizedLines.join('\n');
    }

    private escapeRegExp(string: string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Extracts extra properties from settings string.
     * Assumes "key: value" format per line.
     */
    private extractExtraProperties(): Record<string, string> {
        const extraPropsStr = this.settings.markdownExportExtraProperties;
        if (!extraPropsStr || !extraPropsStr.trim()) return {};

        const extraProps: Record<string, string> = {};
        // Simple manual YAML parsing: "key: value" per line
        // We use parseYaml from obsidian if possible, but it returns any.
        // Let's try simple line parsing first as it's robust for simple k:v pairs.

        const lines = extraPropsStr.split('\n');
        for (const line of lines) {
            const separatorIndex = line.indexOf(':');
            if (separatorIndex > 0) {
                const key = line.substring(0, separatorIndex).trim();
                const value = line.substring(separatorIndex + 1).trim();
                if (key) {
                    extraProps[key] = value;
                }
            }
        }
        return extraProps;
    }

    /**
     * Export the word to a Markdown file with properties.
     */
    async exportWord(word: string, definition: string, aliases?: string[]): Promise<void> {
        const exportPath = this.settings.markdownExportPath;
        if (!exportPath || !exportPath.trim()) {
            return;
        }

        const prompt = this.settings.aiDefinition?.prompt || '';
        const keys = this.extractPropertyKeys(prompt);
        if (keys.length === 0) {
            console.warn('HiWords: No keys found in prompt format for export.');
        }

        const aiProperties = this.extractPropertyValues(definition, keys);
        const extraProperties = this.extractExtraProperties();

        // Merge properties
        const allProperties: Record<string, any> = { ...aiProperties, ...extraProperties };

        // Add aliases if present
        if (aliases && aliases.length > 0) {
            allProperties['aliases'] = aliases;
        }

        // Ensure folder exists
        const folderPath = normalizePath(exportPath);
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            await this.app.vault.createFolder(folderPath);
        }

        const fileName = `${word}.md`;
        const filePath = normalizePath(`${folderPath}/${fileName}`);
        let file = this.app.vault.getAbstractFileByPath(filePath);

        // Construct file content
        // If file exists, we update it. If not, create.
        // Requirement: "如果有相同文件名的md文件，则更新内容"
        // And "将AI返回的释义写入属性内容"

        // We need to manage FrontMatter.

        if (file instanceof TFile) {
            // Pass empty string for content to ensure body is not populated with definition
            await this.updateFile(file, allProperties, '');
        } else {
            await this.createFile(filePath, allProperties, '');
        }
    }

    private async createFile(path: string, properties: Record<string, string>, content: string) {
        // Create file with just the body content first
        const file = await this.app.vault.create(path, content);

        // Then populate properties using standard Obsidian API which handles YAML formatting correctly
        // This ensures multiline strings are formatted as blocks if needed
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            for (const [key, value] of Object.entries(properties)) {
                fm[key] = value;
            }
        });
    }

    private async updateFile(file: TFile, properties: Record<string, any>, content: string) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            for (const [key, value] of Object.entries(properties)) {
                fm[key] = value;
            }
        });

        // Optionally update the body content if we want to sync the full definition text?
        // The requirement mainly focuses on properties updates.
        // "注意，如果有相同文件名的md文件，则更新内容" 
        // Usually `processFrontMatter` only touches frontmatter. 
        // If we want to replace the body, we need `vault.modify`.
        // Let's assume updating properties is the core requirement. 
        // But if the body contains old definition, it might be stale.
        // Let's overwrite the body content too.

        let fileContent = await this.app.vault.read(file);
        // Remove frontmatter to get body
        const fmEndIndex = fileContent.indexOf('---', 3);

        let newBody = content;

        if (fmEndIndex >= 0) {
            // Keep existing frontmatter (processed by processFrontMatter above soon? No, processFrontMatter is async)
            // Actually processFrontMatter reads/writes the file. 
            // If we write body after, we might conflict or overwrite.
            // Better to construct the whole file content if we want to replace body.
        } else {
            // No frontmatter?
        }

        // Safest approach to update both:
        // 1. Read file.
        // 2. Extract existing frontmatter or keys not in new properties (to preserve user added props?)
        // The requirement implies this is a "generated" file for the word.
        // "md文件存储路径支持在设置里面定义" -> It's a sync target.
        // "如果有相同文件名的md文件，则更新内容" -> implied full update of the managed data.

        // Let's stick to `processFrontMatter` for properties as it handles YAML parsing safely.
        // For body, we might skip updating it if not explicitly asked, to avoid messing up user notes if they edit the file.
        // BUT, the prompt implies "将翻译的内容写入该md文档...嵌入属性".
        // If I only update properties, the body remains. 
        // Let's iterate: just update properties as requested. 
        // "将AI返回的释义写入属性内容" -> This is the key. 

        // Wait, if I use `processFrontMatter`, I don't need to manually read/write file string for properties.
    }
}
