import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export type DiagnosticLevel = 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export class Diagnostics implements vscode.Disposable {
	private queue: Promise<void> = Promise.resolve();
	private day = '';
	private retentionDays = -1;
	private readonly directory: string;

	constructor(private readonly channel: vscode.LogOutputChannel, storageUri: vscode.Uri) {
		this.directory = path.join(storageUri.fsPath, 'diagnostics');
		this.updateRetention();
	}

	private settings(): { level: DiagnosticLevel; retentionDays: number } {
		const config = vscode.workspace.getConfiguration('code-openai-oauth');
		const value = config.get<string>('diagnostics.level', 'info');
		const level: DiagnosticLevel = value === 'off' || value === 'error' || value === 'warn' || value === 'debug' || value === 'trace' ? value : 'info';
		const days = config.get<number>('diagnostics.retentionDays', 7);
		return { level, retentionDays: Number.isSafeInteger(days) && days >= 0 && days <= 365 ? days : 7 };
	}

	log(level: Exclude<DiagnosticLevel, 'off'>, message: string): void {
		const settings = this.settings();
		if (settings.retentionDays !== this.retentionDays) { this.updateRetention(); }
		const rank = { off: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
		if (rank[level] > rank[settings.level]) { return; }
		this.channel[level](message);
		if (!settings.retentionDays) { return; }
		const timestamp = new Date();
		const day = timestamp.toISOString().slice(0, 10);
		this.queue = this.queue.then(async () => {
			await fs.mkdir(this.directory, { recursive: true });
			if (this.day !== day) {
				await this.prune(this.retentionDays, timestamp);
				this.day = day;
			}
			await fs.appendFile(path.join(this.directory, `${day}.log`), `${timestamp.toISOString()} [${level}] ${message}\n`);
		}).catch(error => { this.channel.error(`diagnostic archive failed type=${error instanceof Error ? error.name : 'unknown'}`); });
	}

	updateRetention(): void {
		this.retentionDays = this.settings().retentionDays;
		this.queue = this.queue.then(async () => {
			await fs.mkdir(this.directory, { recursive: true });
			await this.prune(this.retentionDays, new Date());
		}).catch(error => { this.channel.error(`diagnostic archive failed type=${error instanceof Error ? error.name : 'unknown'}`); });
	}

	private async prune(retentionDays: number, now: Date): Promise<void> {
		const cutoff = new Date(now);
		cutoff.setUTCHours(0, 0, 0, 0);
		cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays + 1);
		for (const name of await fs.readdir(this.directory)) {
			if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(name) || name.slice(0, 10) >= cutoff.toISOString().slice(0, 10)) { continue; }
			await fs.unlink(path.join(this.directory, name));
		}
	}

	async flush(): Promise<void> { await this.queue; }
	dispose(): void { void this.flush(); }
}