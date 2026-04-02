import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const selector = [
    { language: "sql", scheme: "file" },
    { language: "xml", scheme: "file" },
  ];
  const provider = vscode.languages.registerInlayHintsProvider(
    selector,
    new SQLInsertInlayHintProvider(),
  );
  context.subscriptions.push(provider);
}

class SQLInsertInlayHintProvider implements vscode.InlayHintsProvider {
  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.InlayHint[]> {
    const text = document.getText();
    const hints: vscode.InlayHint[] = [];

    // Find active cursor position to decide which row to show
    const activeEditor = vscode.window.activeTextEditor;
    const cursorOffset = activeEditor
      ? document.offsetAt(activeEditor.selection.active)
      : -1;

    const insertRegex = /INSERT\s+INTO/gi;
    let match;

    while ((match = insertRegex.exec(text))) {
      const startInsert = match.index;

      // 1. Column list
      const openParenIndex = text.indexOf("(", startInsert);
      if (openParenIndex === -1) continue;

      const closeParenIndex = this.findMatchingParen(text, openParenIndex);
      if (closeParenIndex === -1) continue;

      const columnsRaw = text.substring(openParenIndex + 1, closeParenIndex);
      const { items: columns, offsets: columnOffsets } =
        this.splitByCommaWithOffsets(columnsRaw);

      // 2. Find VALUES or SELECT keyword after column list
      const valuesKeywordRegex = /\bVALUES\b/gi;
      valuesKeywordRegex.lastIndex = closeParenIndex;
      const valuesMatch = valuesKeywordRegex.exec(text);

      const selectAfterInsertRegex = /\bSELECT\b/gi;
      selectAfterInsertRegex.lastIndex = closeParenIndex;
      const selectMatch = selectAfterInsertRegex.exec(text);

      const isInsertSelect =
        selectMatch !== null &&
        (valuesMatch === null || selectMatch.index < valuesMatch.index);

      if (isInsertSelect) {
        // INSERT INTO ... SELECT ... FROM ... path
        const afterSelectIdx = selectMatch!.index + selectMatch![0].length;
        const selectExprs = this.extractSelectExpressions(text, afterSelectIdx);

        if (selectExprs && columns.length === selectExprs.length) {
          for (let i = 0; i < columns.length; i++) {
            const colName = columns[i].trim();
            const exprText = selectExprs[i];

            if (colName && exprText) {
              const colOffsetInRaw = columnOffsets[i];
              const colGlobalOffset =
                openParenIndex +
                1 +
                colOffsetInRaw +
                columns[i].indexOf(colName) +
                colName.length;

              const position = document.positionAt(colGlobalOffset);
              if (range.contains(position)) {
                const hint = new vscode.InlayHint(
                  position,
                  `: ${exprText}`,
                  vscode.InlayHintKind.Parameter,
                );
                hint.paddingLeft = true;
                hint.tooltip = new vscode.MarkdownString(
                  `**${colName}**: ${exprText}`,
                );
                hints.push(hint);
              }
            }
          }
        }

        insertRegex.lastIndex = afterSelectIdx;
      } else if (valuesMatch) {
        // INSERT INTO ... VALUES (...) path
        // 3. Find Row: first row OR row near cursor
        let targetValuesRaw = "";
        let currentIdx = valuesMatch.index;
        let foundValues = false;

        // Iterate through rows (v1, v2), (v3, v4)
        while (true) {
          const rowStart = text.indexOf("(", currentIdx);
          if (rowStart === -1) break;

          const rowEnd = this.findMatchingParen(text, rowStart);
          if (rowEnd === -1) break;

          const rowText = text.substring(rowStart + 1, rowEnd);

          // If cursor is within this row, or it's the first row and we haven't found any row yet
          if (
            !foundValues ||
            (cursorOffset >= rowStart && cursorOffset <= rowEnd)
          ) {
            targetValuesRaw = rowText;
            foundValues = true;
          }

          currentIdx = rowEnd + 1;

          // Break if we've passed the cursor AND found at least one row
          if (cursorOffset !== -1 && currentIdx > cursorOffset && foundValues)
            break;

          // Only look for another row if there's a comma
          const nextComma = text.indexOf(",", currentIdx);
          const nextOpen = text.indexOf("(", currentIdx);
          if (nextComma === -1 || (nextOpen !== -1 && nextComma > nextOpen)) {
            // No comma before next row, or no more rows
            if (nextComma === -1) break;
          }
        }

        if (foundValues) {
          const { items: values } =
            this.splitByCommaWithOffsets(targetValuesRaw);

          if (columns.length === values.length) {
            for (let i = 0; i < columns.length; i++) {
              const colName = columns[i].trim();
              const valText = values[i].trim();

              if (colName && valText) {
                const colOffsetInRaw = columnOffsets[i];
                const colGlobalOffset =
                  openParenIndex +
                  1 +
                  colOffsetInRaw +
                  columns[i].indexOf(colName) +
                  colName.length;

                const position = document.positionAt(colGlobalOffset);
                if (range.contains(position)) {
                  const hint = new vscode.InlayHint(
                    position,
                    `: ${valText}`,
                    vscode.InlayHintKind.Parameter,
                  );
                  hint.paddingLeft = true;
                  hint.tooltip = new vscode.MarkdownString(
                    `**${colName}**: ${valText}`,
                  );
                  hints.push(hint);
                }
              }
            }
          }
        }

        insertRegex.lastIndex = currentIdx;
      }
    }

    return hints;
  }

  private extractSelectExpressions(
    text: string,
    startIndex: number,
  ): string[] | null {
    // Skip optional DISTINCT / ALL modifier
    let idx = startIndex;
    const modifierMatch = text.substring(idx).match(/^\s*(DISTINCT|ALL)\s+/i);
    if (modifierMatch) {
      idx += modifierMatch[0].length;
    }

    let depth = 0;
    let inQuote: string | null = null;
    let selectListEnd = -1;

    for (let i = idx; i < text.length; i++) {
      const char = text[i];

      if (char === "'" || char === '"' || char === "`") {
        if (!inQuote) {
          inQuote = char;
        } else if (inQuote === char && (i === 0 || text[i - 1] !== "\\")) {
          inQuote = null;
        }
      }

      if (!inQuote) {
        if (char === "(") {
          depth++;
        } else if (char === ")") {
          if (depth === 0) {
            selectListEnd = i;
            break;
          }
          depth--;
        } else if (depth === 0) {
          const prevOk = i === idx || /\W/.test(text[i - 1]);
          if (prevOk) {
            const remaining = text.substring(i);
            // Stop at FROM or other clause keywords
            const stopAt =
              /^(FROM|WHERE|ORDER|GROUP|HAVING|UNION|EXCEPT|INTERSECT|LIMIT)\b/i;
            if (stopAt.test(remaining)) {
              selectListEnd = i;
              break;
            }
          }
        }
      }
    }

    if (selectListEnd === -1) selectListEnd = text.length;

    const listText = text.substring(idx, selectListEnd);
    const { items } = this.splitByCommaWithOffsets(listText);
    const trimmed = items.map((s) => s.trim()).filter((s) => s.length > 0);
    return trimmed.length > 0 ? trimmed : null;
  }

  private findMatchingParen(text: string, openParenIndex: number): number {
    let depth = 0;
    for (let i = openParenIndex; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  private splitByCommaWithOffsets(text: string): {
    items: string[];
    offsets: number[];
  } {
    const items: string[] = [];
    const offsets: number[] = [];
    let current = "";
    let depth = 0;
    let inQuote: string | null = null;
    let lastOffset = 0;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === "'" || char === '"' || char === "`") {
        if (!inQuote) inQuote = char;
        else if (inQuote === char) {
          if (i > 0 && text[i - 1] !== "\\") inQuote = null;
        }
      }

      if (!inQuote) {
        if (char === "(") depth++;
        else if (char === ")") depth--;
        else if (char === "," && depth === 0) {
          items.push(current);
          offsets.push(lastOffset);
          current = "";
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
