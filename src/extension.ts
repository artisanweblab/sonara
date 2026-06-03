import * as vscode from 'vscode';
import { ActiveProject } from './shared/active-project';
import { registerActiveProjectPicker } from './shared/active-project-view';
import { ensureSonaraProject } from './shared/project-layout';
import { registerTasksModule } from './modules/tasks';
import { registerVoiceModule } from './modules/voice';
import { registerTimeTrackerModule } from './modules/time-tracker';
import { TimerService } from './modules/time-tracker/timer-service';
import { ServerManager } from './modules/voice/server/server-manager';

let timeTracker: TimerService | undefined;
// M5: Held so deactivate() can perform a graceful shutdown of the voice server.
let voiceServer: ServerManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const activeProject = new ActiveProject(context.workspaceState);
    activeProject.init();
    context.subscriptions.push(activeProject);

    const initial = activeProject.get();
    if (initial) {
        ensureSonaraProject(initial);
    }
    context.subscriptions.push(
        activeProject.onDidChange(folder => {
            if (folder) {
                ensureSonaraProject(folder);
            }
        }),
    );

    registerActiveProjectPicker(context, activeProject);

    const tasksHandles = await registerTasksModule(context, activeProject);

    timeTracker = await registerTimeTrackerModule(context, activeProject, tasksHandles.store, tasksHandles.panel);
    // Voice setup may block on Whisper installation. Run it in the background so
    // Tasks and the Active Project view become interactive immediately.
    registerVoiceModule(context, activeProject).then(server => {
        voiceServer = server ?? undefined;
    }).catch(err => {
        console.error('Sonara: voice module failed to initialize', err);
    });
}

export async function deactivate(): Promise<void> {
    if (timeTracker) {
        await timeTracker.flush();
    }
    // M5: Graceful server shutdown - sends HTTP /shutdown, then SIGTERM,
    // and removes port + token files so adopter windows see the server is gone.
    if (voiceServer) {
        await voiceServer.stop(true);
    }
}
