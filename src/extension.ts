import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "ps-blogself" is now active!');

    const disposable = vscode.commands.registerCommand('ps-blogself.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from ps-blogself!');
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
