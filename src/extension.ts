import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const selector = [
        { language: 'sql', scheme: 'file' },
        { language: 'xml', scheme: 'file' }
    ];
    const provider = vscode.languages.registerInlayHintsProvider(
        selector,
        new SQLInsertInlayHintProvider()
    );
    context.subscriptions.push(provider);
}

class SQLInsertInlayHintProvider implements vscode.InlayHintsProvider {
    provideInlayHints(
        document: vscode.TextDocument,
        range: vscode.Range,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.InlayHint[]> {
        const text = document.getText();
        const hints: vscode.InlayHint[] = [];

        // Find active cursor position to decide which row to show
        const activeEditor = vscode.window.activeTextEditor;
        const cursorOffset = activeEditor ? document.offsetAt(activeEditor.selection.active) : -1;

        const insertRegex = /INSERT\s+INTO/gi;
        let match;

        while ((match = insertRegex.exec(text))) {
            const startInsert = match.index;

            // 1. Column list
            const openParenIndex = text.indexOf('(', startInsert);
            if (openParenIndex === -1) continue;

            const closeParenIndex = this.findMatchingParen(text, openParenIndex);
            if (closeParenIndex === -1) continue;

            const columnsRaw = text.substring(openParenIndex + 1, closeParenIndex);
            const { items: columns, offsets: columnOffsets } = this.splitByCommaWithOffsets(columnsRaw);

            // 2. VALUES keyword
            const valuesKeywordRegex = /\bVALUES\b/gi;
            valuesKeywordRegex.lastIndex = closeParenIndex;
            const valuesMatch = valuesKeywordRegex.exec(text);
            if (!valuesMatch) continue;

            // 3. Find Row: first row OR row near cursor
            let targetValuesRaw = '';
            let currentIdx = valuesMatch.index;
            let foundValues = false;

            // Iterate through rows (v1, v2), (v3, v4)
            while (true) {
                const rowStart = text.indexOf('(', currentIdx);
                if (rowStart === -1) break;

                const rowEnd = this.findMatchingParen(text, rowStart);
                if (rowEnd === -1) break;

                const rowText = text.substring(rowStart + 1, rowEnd);

                // If cursor is within this row, or it's the first row and we haven't found any row yet
                if (!foundValues || (cursorOffset >= rowStart && cursorOffset <= rowEnd)) {
                    targetValuesRaw = rowText;
                    foundValues = true;
                }

                currentIdx = rowEnd + 1;

                // Break if we've passed the cursor AND found at least one row
                if (cursorOffset !== -1 && currentIdx > cursorOffset && foundValues) break;

                // Only look for another row if there's a comma
                const nextComma = text.indexOf(',', currentIdx);
                const nextOpen = text.indexOf('(', currentIdx);
                if (nextComma === -1 || (nextOpen !== -1 && nextComma > nextOpen)) {
                    // No comma before next row, or no more rows
                    if (nextComma === -1) break;
                }
            }

            if (foundValues) {
                const { items: values } = this.splitByCommaWithOffsets(targetValuesRaw);

                if (columns.length === values.length) {
                    for (let i = 0; i < columns.length; i++) {
                        const colName = columns[i].trim();
                        const valText = values[i].trim();

                        if (colName && valText) {
                            const colOffsetInRaw = columnOffsets[i];
                            const colGlobalOffset = openParenIndex + 1 + colOffsetInRaw + columns[i].indexOf(colName) + colName.length;

                            const position = document.positionAt(colGlobalOffset);
                            const hint = new vscode.InlayHint(
                                position,
                                `: ${valText}`,
                                vscode.InlayHintKind.Parameter
                            );
                            hint.paddingLeft = true;
                            hints.push(hint);
                        }
                    }
                }
            }

            insertRegex.lastIndex = currentIdx;
        }

        return hints;
    }

    private findMatchingParen(text: string, openParenIndex: number): number {
        let depth = 0;
        for (let i = openParenIndex; i < text.length; i++) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')') {
                depth--;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    private splitByCommaWithOffsets(text: string): { items: string[], offsets: number[] } {
        const items: string[] = [];
        const offsets: number[] = [];
        let current = '';
        let depth = 0;
        let inQuote: string | null = null;
        let lastOffset = 0;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (char === "'" || char === '"' || char === '`') {
                if (!inQuote) inQuote = char;
                else if (inQuote === char) {
                    if (i > 0 && text[i - 1] !== '\\') inQuote = null;
                }
            }

            if (!inQuote) {
                if (char === '(') depth++;
                else if (char === ')') depth--;
                else if (char === ',' && depth === 0) {
                    items.push(current);
                    offsets.push(lastOffset);
                    current = '';
                    lastOffset = i + 1;
                    continue;
                }
            }
            current += char;
        }
        items.push(current);
        offsets.push(lastOffset);
        return { items, offsets };
    }
}
