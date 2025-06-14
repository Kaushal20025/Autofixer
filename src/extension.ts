import * as vscode from 'vscode';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ActionsViewProvider } from './actionsView';

export async function activate(context: vscode.ExtensionContext) {
    try {
        console.log('Code Analyzer Pro is now active!');

        const config = vscode.workspace.getConfiguration('codeAnalyzerPro');
        const apiKey = config.get<string>('apiKey');

        if (!apiKey) {
            vscode.window.showErrorMessage('Please set your Gemini API key in settings');
            return;
        }

        console.log('Initializing Gemini AI...');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        // Create diagnostic collection for code issues
        const diagnosticCollection = vscode.languages.createDiagnosticCollection('codeAnalyzerPro');
        context.subscriptions.push(diagnosticCollection);

        // Initialize the tree view
        const treeDataProvider = new SuggestionsTreeDataProvider();
        const treeView = vscode.window.createTreeView('autofixerSuggestions', {
            treeDataProvider,
            showCollapseAll: true
        });
        context.subscriptions.push(treeView);

        // Register the actions view
        const actionsViewProvider = new ActionsViewProvider(context.extensionUri, apiKey);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(ActionsViewProvider.viewType, actionsViewProvider)
        );

        // Function to automatically fix code issues
        async function autoFixCode(document: vscode.TextDocument) {
            try {
                const text = document.getText();
                console.log('Analyzing file:', document.fileName);
                console.log('File content:', text);

                const prompt = `Analyze this code and provide fixes. For each issue, provide:
                1. Line number
                2. Issue type (e.g., 'syntax', 'style', 'security', 'performance')
                3. Issue description
                4. Fixed code for that line
                
                Format each fix as: LINE_NUMBER|ISSUE_TYPE|DESCRIPTION|FIXED_CODE
                
                Example:
                5|style|Use const instead of let for unchanging variable|const name = 'John';
                
                Code to analyze:
                ${text}`;

                console.log('Sending prompt to Gemini...');
                const result = await model.generateContent([prompt]);
                const response = await result.response;
                const analysis = response.text();
                console.log('Analysis response:', analysis);
                
                const fixes = parseSuggestions(analysis);
                console.log('Parsed fixes:', JSON.stringify(fixes, null, 2));
                
                if (fixes.length > 0) {
                    console.log('Found fixes:', fixes.length);
                    const editor = await vscode.window.showTextDocument(document);
                    
                    // Create diagnostics for the issues
                    const diagnostics: vscode.Diagnostic[] = [];
                    
                    // Sort fixes by line number in reverse order to avoid line number shifts
                    fixes.sort((a, b) => b.line - a.line);
                    
                    for (const fix of fixes) {
                        try {
                            console.log(`Processing fix for line ${fix.line}:`, fix);
                            const line = document.lineAt(fix.line - 1);
                            const range = new vscode.Range(
                                new vscode.Position(fix.line - 1, 0),
                                new vscode.Position(fix.line - 1, line.text.length)
                            );
                            
                            // Add diagnostic
                            const diagnostic = new vscode.Diagnostic(
                                range,
                                fix.text,
                                vscode.DiagnosticSeverity.Warning
                            );
                            diagnostic.source = 'Code Analyzer Pro';
                            diagnostics.push(diagnostic);
                            
                            // Apply fix
                            console.log(`Applying fix at line ${fix.line}:`, {
                                original: line.text,
                                fixed: fix.fixCode
                            });
                            
                            await editor.edit(editBuilder => {
                                editBuilder.replace(range, fix.fixCode);
                            });
                            
                            console.log(`Successfully applied fix at line ${fix.line}`);
                        } catch (error) {
                            console.error(`Error applying fix at line ${fix.line}:`, error);
                        }
                    }
                    
                    // Update diagnostics
                    diagnosticCollection.set(document.uri, diagnostics);
                    treeDataProvider.updateSuggestions(document.uri, fixes);
                    
                    // Show success message
                    vscode.window.showInformationMessage(`Applied ${fixes.length} fixes to ${document.fileName}`);
                } else {
                    console.log('No fixes needed for:', document.fileName);
                }
            } catch (error) {
                console.error('Auto-fix error:', error);
                vscode.window.showErrorMessage(`Error analyzing code: ${error}`);
            }
        }

        // Add file open event handler
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(async (document) => {
                if (document.languageId === 'javascript' || 
                    document.languageId === 'typescript' || 
                    document.languageId === 'python' || 
                    document.languageId === 'java' || 
                    document.languageId === 'c' || 
                    document.languageId === 'cpp' || 
                    document.languageId === 'csharp') {
                    console.log('File opened:', document.fileName, 'Language:', document.languageId);
                    await autoFixCode(document);
                }
            })
        );

        // Watch for file changes with debounce
        let timeout: NodeJS.Timeout | undefined;
        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document.uri.scheme === 'file') {
                    if (timeout) {
                        clearTimeout(timeout);
                    }
                    timeout = setTimeout(() => {
                        console.log('File changed:', event.document.fileName);
                        autoFixCode(event.document);
                    }, 1000); // Wait 1 second after last change
                }
            })
        );

        // Register hover provider
        context.subscriptions.push(
            vscode.languages.registerHoverProvider('*', {
                provideHover(document, position) {
                    const diagnostics = diagnosticCollection.get(document.uri);
                    if (!diagnostics) return undefined;

                    const diagnostic = diagnostics.find(d => d.range.contains(position));
                    if (diagnostic) {
                        const hoverMessage = new vscode.MarkdownString(`**Issue:** ${diagnostic.message}`);
                        return new vscode.Hover(hoverMessage);
                    }
                    return undefined;
                }
            })
        );

        // Show activation message
        vscode.window.showInformationMessage('Code Analyzer Pro is now active!');

    } catch (error) {
        console.error('Extension activation error:', error);
        vscode.window.showErrorMessage(`Failed to activate Code Analyzer Pro: ${error}`);
    }
}

interface Suggestion {
    line: number;
    type: string;
    text: string;
    fixCode: string;
}

function parseSuggestions(analysis: string): Suggestion[] {
    console.log('Parsing suggestions from:', analysis);
    const suggestions: Suggestion[] = [];
    const lines = analysis.split('\n');
    
    for (const line of lines) {
        console.log('Processing line:', line);
        const parts = line.split('|');
        if (parts.length === 4) {
            const suggestion = {
                line: parseInt(parts[0]),
                type: parts[1],
                text: parts[2],
                fixCode: parts[3]
            };
            console.log('Parsed suggestion:', suggestion);
            suggestions.push(suggestion);
        }
    }
    
    console.log('Total suggestions parsed:', suggestions.length);
    return suggestions;
}

class SuggestionsTreeDataProvider implements vscode.TreeDataProvider<SuggestionItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SuggestionItem | undefined | null | void> = new vscode.EventEmitter<SuggestionItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<SuggestionItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private suggestions: Map<string, Suggestion[]> = new Map();

    updateSuggestions(uri: vscode.Uri, suggestions: Suggestion[]) {
        console.log('Updating suggestions for:', uri.toString());
        this.suggestions.set(uri.toString(), suggestions);
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SuggestionItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SuggestionItem): Thenable<SuggestionItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        const items: SuggestionItem[] = [];
        this.suggestions.forEach((suggestions) => {
            suggestions.forEach(suggestion => {
                items.push(new SuggestionItem(suggestion));
            });
        });

        return Promise.resolve(items);
    }
}

class SuggestionItem extends vscode.TreeItem {
    constructor(suggestion: Suggestion) {
        super(suggestion.text);
        this.tooltip = suggestion.fixCode;
        this.description = `Line ${suggestion.line}`;
    }
}

export function deactivate() {} 
