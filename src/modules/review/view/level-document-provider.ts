import * as vscode from 'vscode';
import { ReviewService } from '../review-service';
import { ReviewServiceHolder } from '../review-service-holder';
import { LevelDocument, REVIEW_LEVELS, ReviewLevel } from '../types';
import { LevelTextDecoder } from './level-text-decoder';

export type LevelDocumentSide = 'before' | 'after';

export interface LevelDocumentAddress {
    repoPath: string;
    level: ReviewLevel;
    side: LevelDocumentSide;
}

const DOCUMENT_CACHE_MS = 3000;

export class LevelDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    static readonly SCHEME = 'sonara-review';

    private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.emitter.event;
    private readonly buildEmitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidBuild = this.buildEmitter.event;
    private readonly generations = new Map<string, string>();
    private readonly pending = new Map<string, Promise<LevelDocument | null>>();
    private readonly shown = new Map<string, LevelDocument>();
    private readonly decoder = new LevelTextDecoder();
    private readonly subscription: vscode.Disposable;
    private service: ReviewService | undefined;

    constructor(private readonly holder: ReviewServiceHolder) {
        this.service = holder.get();
        this.subscription = vscode.Disposable.from(
            holder.onDidChange(() => this.onServiceChange()),
            vscode.workspace.onDidCloseTextDocument(document => this.forget(document.uri)),
        );
    }

    static uriFor(address: LevelDocumentAddress): vscode.Uri {
        const query = new URLSearchParams({ level: address.level, side: address.side }).toString();
        return vscode.Uri.from({ scheme: LevelDocumentProvider.SCHEME, path: `/${address.repoPath}`, query });
    }

    static parse(uri: vscode.Uri): LevelDocumentAddress | null {
        if (uri.scheme !== LevelDocumentProvider.SCHEME) {
            return null;
        }
        const params = new URLSearchParams(uri.query);
        const level = REVIEW_LEVELS.find(candidate => candidate === params.get('level'));
        const side = params.get('side');
        if (!level || (side !== 'before' && side !== 'after')) {
            return null;
        }
        return { repoPath: uri.path.replace(/^\//, ''), level, side };
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const address = LevelDocumentProvider.parse(uri);
        const service = this.holder.get();
        if (!address || !service) {
            return '';
        }
        this.generations.set(uri.toString(), service.getFile(address.repoPath)?.signature ?? '');
        const document = await this.request(address.repoPath, address.level);
        if (!document) {
            this.shown.delete(uri.toString());
            return '';
        }
        this.shown.set(uri.toString(), document);
        this.buildEmitter.fire(uri);
        const content = address.side === 'before' ? document.before : document.after;
        return this.decoder.decode(content, vscode.Uri.file(service.absolutePath(address.repoPath)));
    }

    async firstChangeLine(repoPath: string, level: ReviewLevel): Promise<number> {
        const document = await this.request(repoPath, level);
        return document?.changes[0]?.line ?? 0;
    }

    async sideToShow(repoPath: string, level: ReviewLevel): Promise<LevelDocumentSide | null> {
        const document = await this.request(repoPath, level);
        if (!document || document.isBeforeMissing === document.isAfterMissing) {
            return null;
        }
        return document.isBeforeMissing ? 'after' : 'before';
    }

    private request(repoPath: string, level: ReviewLevel): Promise<LevelDocument | null> {
        const service = this.holder.get();
        if (!service) {
            return Promise.resolve(null);
        }
        const cacheKey = `${repoPath}\0${level}\0${service.getFile(repoPath)?.signature ?? ''}`;
        let request = this.pending.get(cacheKey);
        if (!request) {
            request = service.levelDocument(repoPath, level);
            this.pending.set(cacheKey, request);
            setTimeout(() => this.pending.delete(cacheKey), DOCUMENT_CACHE_MS);
        }
        return request;
    }

    shownDocument(uri: vscode.Uri): LevelDocument | undefined {
        return this.shown.get(uri.toString());
    }

    refreshPath(repoPath: string): void {
        for (const document of vscode.workspace.textDocuments) {
            if (LevelDocumentProvider.parse(document.uri)?.repoPath === repoPath) {
                this.generations.delete(document.uri.toString());
                this.emitter.fire(document.uri);
            }
        }
    }

    private onServiceChange(): void {
        const service = this.holder.get();
        if (service !== this.service) {
            this.service = service;
            this.generations.clear();
            this.shown.clear();
            this.pending.clear();
        }
        this.refreshStale();
    }

    private forget(uri: vscode.Uri): void {
        if (uri.scheme !== LevelDocumentProvider.SCHEME) {
            return;
        }
        this.generations.delete(uri.toString());
        this.shown.delete(uri.toString());
    }

    private refreshStale(): void {
        const service = this.holder.get();
        for (const document of vscode.workspace.textDocuments) {
            const address = LevelDocumentProvider.parse(document.uri);
            if (!address) {
                continue;
            }
            const key = document.uri.toString();
            const signature = service?.getFile(address.repoPath)?.signature ?? '';
            if (this.generations.get(key) !== signature) {
                this.generations.set(key, signature);
                this.emitter.fire(document.uri);
            }
        }
    }

    dispose(): void {
        this.subscription.dispose();
        this.emitter.dispose();
        this.buildEmitter.dispose();
        this.shown.clear();
        this.generations.clear();
        this.pending.clear();
    }
}
