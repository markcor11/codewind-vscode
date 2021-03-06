/*******************************************************************************
 * Copyright (c) 2018, 2020 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v2.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v20.html
 *
 * Contributors:
 *     IBM Corporation - initial API and implementation
 *******************************************************************************/

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as request from "request-promise-native";

import MCUtil from "../../MCUtil";
import ProjectState from "./ProjectState";
import Log from "../../Logger";
import Translator from "../../constants/strings/translator";
import StringNamespaces from "../../constants/strings/StringNamespaces";
import ProjectCapabilities, { StartModes } from "./ProjectCapabilities";
import MCLogManager from "./logs/MCLogManager";
import DebugUtils from "./DebugUtils";
import ProjectType from "./ProjectType";
import ProjectPendingRestart from "./ProjectPendingRestart";
import Connection from "../connection/Connection";
import SocketEvents from "../connection/SocketEvents";
import Validator from "./Validator";
import Requester from "./Requester";
import { deleteProjectDir } from "../../command/project/RemoveProjectCmd";
import Constants from "../../constants/Constants";
import Commands from "../../constants/Commands";
import { getCodewindIngress } from "../../command/project/OpenPerfDashboard";
import EndpointUtil from "../../constants/Endpoints";
import ProjectOverviewPageWrapper from "../../command/webview/ProjectOverviewPageWrapper";

/**
 * Used to determine App Monitor URL
 */
const langToPathMap = new Map<string, string>();
langToPathMap.set("java", "javametrics-dash");
langToPathMap.set("nodejs", "appmetrics-dash");
langToPathMap.set("javascript", "appmetrics-dash");
langToPathMap.set("swift", "swiftmetrics-dash");

const STRING_NS = StringNamespaces.PROJECT;

/**
 * Project's ports info. Keys match those provided by backend.
 */
interface IProjectPorts {
    appPort: number | undefined;
    internalPort: number | undefined;
    debugPort: number | undefined;
    internalDebugPort: number | undefined;
}

export default class Project implements vscode.QuickPickItem {

    public readonly initPromise: Promise<void>;

    // Immutable project data
    public readonly name: string;
    public readonly id: string;
    public readonly type: ProjectType;
    public readonly language: string;
    // abs path to the project on the user's filesystem
    public readonly localPath: vscode.Uri;
    // abs path to the source code within the container, used for debug source mapping so only set for specific project types.
    public readonly containerAppRoot: string | undefined;

    private _capabilities: ProjectCapabilities | undefined;

    // Mutable project data, will change with calls to update() and similar functions. Prefixed with _ because these all have getters.
    private readonly _state: ProjectState;
    private _containerID: string | undefined;
    private _contextRoot: string;
    private readonly _ports: IProjectPorts;
    private appBaseURL: vscode.Uri | undefined;
    private _autoBuildEnabled: boolean;
    private _usesHttps: boolean;
    // Dates below will always be set, but might be "invalid date"s
    private _lastBuild: Date;
    private _lastImgBuild: Date;
    // does this project appear to have a /metrics endpoint available
    private _metricsAvailable: boolean = false;
    // does this project have the 'inject metrics' feature enabled by the user
    private _injectMetricsEnabled: boolean;
    // can we query filewatcher for this project's capabilities
    private _capabilitiesReady: boolean;

    public static readonly diagnostics: vscode.DiagnosticCollection
        = vscode.languages.createDiagnosticCollection(Validator.DIAGNOSTIC_COLLECTION_NAME);

    // in MS
    private readonly RESTART_TIMEOUT: number = 180 * 1000;
    // Represents a pending restart operation. Only set if the project is currently restarting.
    private pendingRestart: ProjectPendingRestart | undefined;

    // Active ProjectInfo webviewPanel. Only one per project. Undefined if no project overview page is active.
    // Track this so we can refresh it when update() is called, and prevent multiple webviews being open for one project.
    private _overviewPage: ProjectOverviewPageWrapper | undefined;

    public readonly logManager: MCLogManager;

    private resolvePendingDeletion: (() => void) | undefined;
    private deleteFilesOnUnbind: boolean = false;

    constructor(
        projectInfo: any,
        public readonly connection: Connection,
    ) {
        Log.d("Creating project from info:", projectInfo);
        this.name = projectInfo.name;
        this.id = projectInfo.projectID;

        const extensionName = (projectInfo.extension) ? projectInfo.extension.name : undefined;
        this.type = new ProjectType(projectInfo.projectType, projectInfo.language, extensionName);
        this.language = projectInfo.language || "Unknown";
        this.localPath = vscode.Uri.file(projectInfo.locOnDisk);
        this._contextRoot = projectInfo.contextRoot || projectInfo.contextroot || "";
        this._usesHttps = projectInfo.isHttps === true;

        if (projectInfo.extension && projectInfo.extension.config) {
            this.containerAppRoot = projectInfo.extension.config.containerAppRoot;
        }
        if (!this.containerAppRoot) {
            this.containerAppRoot = projectInfo.containerAppRoot;
        }

        // These will be overridden by the call to update(), but we set them here too so the compiler can see they're always set.
        this._autoBuildEnabled = projectInfo.autoBuild;
        // lastbuild is a number
        this._lastBuild = new Date(projectInfo.lastbuild);
        // appImageLastBuild is a string
        this._lastImgBuild = new Date(Number(projectInfo.appImgLastBuild));

        this._injectMetricsEnabled = projectInfo.injectMetrics || false;
        // this field won't be here pre-0.8
        // https://github.com/eclipse/codewind/pull/1774/files
        this._capabilitiesReady = projectInfo.capabilitiesReady || false;

        this._ports = {
            appPort: undefined,
            debugPort: undefined,
            internalPort: undefined,
            internalDebugPort: undefined,
        };

        this._state = new ProjectState(this.name);
        this._state = this.update(projectInfo);

        // if the inf data has logs and the project is enabled, logs are available now. Else, we have to wait for logsListChanged events.
        const canGetLogs = this._state.isEnabled && projectInfo.logs != null;
        this.logManager = new MCLogManager(this, canGetLogs);

        // Do any async initialization work that must be done before the project is ready, here.
        // The function calling the constructor must await on this promise before expecting the project to be ready.
        this.initPromise = Promise.all([
            this.updateCapabilities(),
            this.updateMetricsAvailable()
        ])
        .then(() => Promise.resolve());

        Log.i(`Created ${this.type.toString()} project ${this.name} with ID ${this.id} at ${this.localPath.fsPath}`);
    }

    public toString(): string {
        return this.name;
    }

    /**
     * Set this project's status based on the project info event payload passed.
     * This includes checking the appStatus, buildStatus, buildStatusDetail, and startMode.
     * Also updates the appPort and debugPort.
     */
    public update = (projectInfo: any): ProjectState => {
        if (projectInfo.projectID !== this.id) {
            // shouldn't happen, but just in case
            Log.e(`Project ${this.id} received status update request for wrong project ${projectInfo.projectID}`);
            // return the old state
            return this._state;
        }

        this.setContainerID(projectInfo.containerId);
        // lastbuild is a number while appImageLastBuild is a string
        this.setLastBuild(projectInfo.lastbuild);
        this.setLastImgBuild(Number(projectInfo.appImageLastBuild));
        this.setAutoBuild(projectInfo.autoBuild);
        this.setInjectMetrics(projectInfo.injectMetrics);

        if (projectInfo.isHttps) {
            this._usesHttps = projectInfo.isHttps === true;
        }

        if (projectInfo.contextRoot) {
            this._contextRoot = projectInfo.contextRoot;
        }

        if (projectInfo.appBaseURL) {
            const asUri = vscode.Uri.parse(projectInfo.appBaseURL);
            if (!asUri.scheme || !asUri.authority) {
                Log.e(`Bad appBaseURL "${projectInfo.appBaseURL}" provided; missing scheme or authority`);
            }
            this.appBaseURL = asUri;
        }

        const oldCapabilitiesReady = this._capabilitiesReady;
        this._capabilitiesReady = projectInfo.capabilitiesReady;
        if (oldCapabilitiesReady !== this._capabilitiesReady) {
            // Log.d(`${this.name} capabilities now ready`);
            this.updateCapabilities();
        }

        const wasEnabled = this.state.isEnabled;
        const oldStateStr = this.state.toString();
        const stateChanged = this.state.update(projectInfo);

        if (stateChanged) {
            const startModeMsg = projectInfo.startMode == null ? "" : `, startMode=${projectInfo.startMode}`;
            Log.d(`${this.name} went from ${oldStateStr} to ${this._state}${startModeMsg}`);

            // Check if the project was just enabled or disabled
            if (wasEnabled && !this.state.isEnabled) {
                this.onDisable();
            }
            else if (!wasEnabled && this.state.isEnabled) {
                this.onEnable();
            }
        }

        const ports = projectInfo.ports;
        if (ports) {
            this.updatePorts(ports);
        }
        else if (this._state.isStarted) {
            Log.e("No ports were provided for an app that is supposed to be started");
        }

        if (this.pendingRestart != null) {
            this.pendingRestart.onStateChange(this.state.appState);
        }

        this.onChange();

        return this._state;
    }

    /**
     * Call when this project's mutable fields change
     * to update the tree view and project info pages.
     */
    private onChange(): void {
        this.connection.onChange(this);
        this._overviewPage?.refresh();
    }

    /**
     * Update this project's port fields. Does not call onChange().
     * @param ports - Ports object from a socket event or Project info
     * @returns true if at least one port was changed
     */
    private updatePorts(ports: {
        exposedPort?: string | undefined;
        exposedDebugPort?: string | undefined;
        internalPort?: string | undefined;
        internalDebugPort?: string | undefined;
    }): boolean {
        let changed = false;
        changed = this.setPort(ports.exposedPort, "appPort");
        changed = this.setPort(ports.exposedDebugPort, "debugPort") || changed;
        changed = this.setPort(ports.internalPort, "internalPort") || changed;
        changed = this.setPort(ports.internalDebugPort, "internalDebugPort") || changed;

        return changed;
    }

    public onSettingsChangedEvent(event: SocketEvents.IProjectSettingsEvent): void {
        Log.d("project settings changed " + this.name, event);

        if (event.status !== SocketEvents.STATUS_SUCCESS) {
            let errMsg = "Project settings update failed: ";
            Log.e(errMsg, event.error);
            if (event.error) {
                errMsg += " " + event.error;
            }
            vscode.window.showErrorMessage(errMsg);
            // We still continue with the update even in the case of error
        }

        // Only one of contextroot, app port, or debug port should be set
        // but there's no reason to treat it differently if multiple are set
        let changed = false;
        if (event.contextRoot) {
            let newContextRoot = event.contextRoot;
            // Remove leading / if present
            if (newContextRoot.startsWith("/")) {
                newContextRoot = newContextRoot.substring(1, newContextRoot.length);
            }
            this._contextRoot = event.contextRoot;
            Log.i("ContextRoot now " + this._contextRoot);
            changed = true;
        }
        if (event.ports) {
            if (event.ports.internalPort) {
                changed = this.setPort(event.ports.internalPort, "internalPort");
            }
            else if (event.ports.internalDebugPort) {
                changed = this.setPort(event.ports.internalDebugPort, "internalDebugPort");
            }
            else {
                Log.e("Received unexpected ports response:", event.ports);
            }
        }

        if (changed) {
            this.onChange();
        }
    }

    public doRestart(mode: StartModes): boolean {
        if (this.pendingRestart != null) {
            // should be prevented by the RestartProjectCommand
            Log.e(this.name + ": doRestart called when already restarting");
            return false;
        }

        this.pendingRestart = new ProjectPendingRestart(this, mode, this.RESTART_TIMEOUT);
        return true;
    }

    public onRestartFinish(): void {
        Log.d(this.name + ": onRestartFinish");
        this.pendingRestart = undefined;
    }

    /**
     * Validate the restart event. If it succeeded, update ports.
     * Notifies the pendingRestart.
     */
    public onRestartEvent(event: SocketEvents.IProjectRestartedEvent): void {
        let success: boolean;
        let errMsg: string | undefined;

        if (this.pendingRestart == null) {
            Log.e(this.name + ": received restart event without a pending restart", event);
            return;
        }

        if (SocketEvents.STATUS_SUCCESS !== event.status) {
            Log.e(`${this.name}: Restart failed, response is`, event);

            errMsg = Translator.t(STRING_NS, "genericErrorProjectRestart", { thisName: this.name });
            if (event.errorMsg != null) {
                errMsg = event.errorMsg;
            }

            success = false;
        }
        else if (event.ports == null || event.startMode == null ||
                !ProjectCapabilities.allStartModes.map((mode) => mode.toString()).includes(event.startMode)) {

            // If the status is "success" (as we just checked), these must all be set and valid
            errMsg = Translator.t(StringNamespaces.DEFAULT, "genericErrorProjectRestart", { thisName: this.name });
            Log.e(errMsg + ", payload:", event);

            success = false;
        }
        else {
            Log.d("Restart event is valid");
            this.updatePorts(event.ports);
            // https://github.com/eclipse/codewind/issues/311
            if (event.containerId) {
                this.setContainerID(event.containerId);
            }
            this.onChange();
            success = true;
        }

        this.pendingRestart.onReceiveRestartEvent(success, errMsg);
    }

    private async updateCapabilities(): Promise<void> {
        let capabilities: ProjectCapabilities;
        if (!this.state.isEnabled || !this._capabilitiesReady) {
            // The project must refresh the capabilities on re-enable, or when capabilitiesReady becomes true.
            // server will return a 404 in this case
            capabilities = ProjectCapabilities.NO_CAPABILITIES;
        }
        else {
            try {
                capabilities = await Requester.getCapabilities(this);
            }
            catch (err) {
                // If the project is enabled and there is an error, we fall back to all capabilities so as not to block any UI actions.
                // But this should never happen
                Log.e("Error retrieving capabilities for " + this.name, err);
                capabilities = ProjectCapabilities.NO_CAPABILITIES;
            }
        }
        this._capabilities = capabilities;
        this.onChange();
    }

    private async updateMetricsAvailable(): Promise<void> {
        const oldMetricsAvailable = this._metricsAvailable;
        try {
            this._metricsAvailable = await Requester.areMetricsAvailable(this);
            if (oldMetricsAvailable !== this._metricsAvailable) {
                this.onChange();
            }
        }
        catch (err) {
            Log.e(`Error checking metrics status for ${this.name}`, err);
        }
    }

    public onConnectionReconnect(): void {
        this.logManager.onReconnectOrEnable();
    }

    public onConnectionDisconnect(): void {
        if (this.pendingRestart != null) {
            this.pendingRestart.onDisconnectOrDisable(true);
        }
        this.logManager.onDisconnect();
    }

    public async onEnable(): Promise<void> {
        Log.i(`${this.name} has been enabled`);
        this.logManager.onReconnectOrEnable();
        await this.updateCapabilities();
    }

    public async onDisable(): Promise<void> {
        Log.i(`${this.name} has been disabled`);
        if (this.pendingRestart != null) {
            this.pendingRestart.onDisconnectOrDisable(false);
        }
        // this.logManager.destroyAllLogs();
        this.logManager?.destroyAllLogs();
    }

    public async dispose(): Promise<void> {
        await Promise.all([
            this.clearValidationErrors(),
            this.logManager?.destroyAllLogs(),
            this._overviewPage != null ? this._overviewPage.dispose() : Promise.resolve(),
        ]);
        this.connection.onChange(this);
    }

    public deleteFromCodewind(deleteFiles: boolean): Promise<void> {
        Log.d(`Deleting ${this}`);
        this.deleteFilesOnUnbind = deleteFiles;
        const pendingDeletionProm = new Promise<void>((resolve) => {
            this.resolvePendingDeletion = resolve;
            Requester.requestUnbind(this);
        });
        return pendingDeletionProm;
    }

    public async onDeletionEvent(event: SocketEvents.DeletionResult): Promise<void> {
        if (!this.resolvePendingDeletion) {
            Log.e(`Received deletion event for ${this} that was not pending deletion`);
            return;
        }

        if (event.status !== SocketEvents.STATUS_SUCCESS) {
            Log.e(`Received bad deletion event for ${this}`, event);
            vscode.window.showErrorMessage(`Error deleting ${this.name}`);
            // resolve the pending deletion because they will have to try again
            this.resolvePendingDeletion();
            return;
        }

        Log.i(`${this} was deleted from ${this.connection.label}`);
        DebugUtils.removeDebugLaunchConfigFor(this);

        const deleteFilesProm = this.deleteFilesOnUnbind ? deleteProjectDir(this) : Promise.resolve();
        await Promise.all([
            deleteFilesProm,
            this.dispose(),
        ]);
        this.resolvePendingDeletion();
        Log.d(`Finished deleting ${this}`);
    }

    /**
     * Clear all diagnostics for this project's path
     */
    public async clearValidationErrors(): Promise<void> {
        Project.diagnostics.delete(this.localPath);
    }

    ///// ProjectOverview

    public onDidOpenOverviewPage(overviewPage: ProjectOverviewPageWrapper): void {
        this._overviewPage = overviewPage;
    }

    public get overviewPage(): ProjectOverviewPageWrapper | undefined {
        return this._overviewPage;
    }

    public onDidCloseOverviewPage(): void {
        this._overviewPage = undefined;
    }

    ///// Getters

    // QuickPickItem
    public get label(): string {
        return Translator.t(STRING_NS, "quickPickLabel", { projectName: this.name, projectType: this.type.toString() });
    }

    // QuickPickItem
    public get description(): string {
        const appUrl = this.appUrl;
        if (appUrl != null) {
            return appUrl.toString();
        }
        else {
            return Translator.t(STRING_NS, "quickPickNotRunning");
        }
    }

    // QuickPickItem
    public get detail(): string {
        return this.connection.label;
    }

    public get isRestarting(): boolean {
        return this.pendingRestart != null;
    }

    public get containerID(): string | undefined {
        return this._containerID;
    }

    public get contextRoot(): string {
        return this._contextRoot;
    }

    public get ports(): IProjectPorts {
        return this._ports;
    }

    public get autoBuildEnabled(): boolean {
        return this._autoBuildEnabled;
    }

    public get state(): ProjectState {
        return this._state;
    }

    public get capabilities(): ProjectCapabilities {
        // This will only happen if this funciton is called before the initPromise resolves, which should never happen
        if (!this._capabilities) {
            this._capabilities = ProjectCapabilities.ALL_CAPABILITIES;
        }
        return this._capabilities;
    }

    public get metricsAvailable(): boolean {
        return this._metricsAvailable;
    }

    public get hasAppMonitor(): boolean {
        return this.type.alwaysHasAppMonitor || this.metricsAvailable;
    }

    public get hasPerfDashboard(): boolean {
        return this.metricsAvailable || this.injectMetricsEnabled;
    }

    public get appUrl(): vscode.Uri | undefined {
        // If the backend has provided us with a baseUrl already, use that
        if (this.appBaseURL) {
            return this.appBaseURL.with({
                path: this._contextRoot,
            });
        }

        if (this._ports.appPort == null || isNaN(this._ports.appPort)) {
            // app is stopped, disabled, etc.
            return undefined;
        }

        const scheme = this._usesHttps ? "https" : "http";                  // non-nls

        return this.connection.url.with({
            scheme,
            authority: `${this.connection.host}:${this._ports.appPort}`,    // non-nls
            path: this._contextRoot
        });
    }

    public get debugUrl(): string | undefined {
        if (this._ports.debugPort == null || isNaN(this._ports.debugPort)) {
            return undefined;
        }

        return this.connection.host + ":" + this._ports.debugPort;            // non-nls
    }

    public get lastBuild(): Date {
        return this._lastBuild;
    }

    public get lastImgBuild(): Date {
        return this._lastImgBuild;
    }

    public get hasContextRoot(): boolean {
        return this._contextRoot != null && this._contextRoot.length > 0 && this._contextRoot !== "/";
    }

    public get appMonitorUrl(): string | undefined {
        const appMetricsPath = langToPathMap.get(this.type.language);
        const supported = appMetricsPath != null && this.metricsAvailable;
        if ((!this._injectMetricsEnabled) && supported) {
            // open app monitor in Application container
            Log.d(`${this.name} supports metrics ? ${supported}`);
            if (this.appUrl === undefined) {
                return undefined;
            }
            let monitorPageUrlStr = this.appUrl.toString();
            if (!monitorPageUrlStr.endsWith("/")) {
                monitorPageUrlStr += "/";
            }
            return monitorPageUrlStr + appMetricsPath + "/?theme=dark";
        }

        try {
            // open app monitor in Performance container
            const cwBaseUrl = global.isTheia ? getCodewindIngress() : this.connection.url;
            const dashboardUrl = EndpointUtil.getPerformanceMonitor(cwBaseUrl, this.language, this.id);
            Log.d(`Perf container Monitor Dashboard url for ${this.name} is ${dashboardUrl}`);
            return dashboardUrl.toString();
        }
        catch (err) {
            Log.e(`${this} error determining app monitor URL`, err);
            vscode.window.showErrorMessage(MCUtil.errToString(err));
            return undefined;
        }
    }

    public get canContainerShell(): boolean {
        return !this.connection.isRemote; // && !!this.containerID;
    }

    public get isInVSCodeWorkspace(): boolean {
        return !!vscode.workspace.workspaceFolders &&
            vscode.workspace.workspaceFolders.some((folder) => this.localPath.fsPath.startsWith(folder.uri.fsPath));
    }

    public get injectMetricsEnabled(): boolean {
        return this._injectMetricsEnabled;
    }

    ///// Setters

    /**
     * Set one of this project's Port fields.
     * @param newPort Can be undefined if the caller wishes to "unset" the port (ie, because the app is stopping)
     * @returns true if at least one port was changed.
     */
    private setPort(newPort: string | undefined, portType: keyof IProjectPorts): boolean {
        if (newPort === "") {
            newPort = undefined;
        }
        const newPortNumber = Number(newPort);
        const currentPort = this._ports[portType];

        if (newPort && !MCUtil.isGoodPort(newPortNumber)) {
            Log.w(`Invalid ${portType} port ${newPort} given to project ${this.name}, ignoring it`);
            return false;
        }
        else if (currentPort !== newPortNumber) {
            if (isNaN(newPortNumber)) {
                if (this._ports[portType]) {
                    Log.d(`Unset ${portType} for ${this.name}`);
                }
                this._ports[portType] = undefined;
            }
            else if (newPortNumber !== currentPort) {
                Log.d(`New ${portType} for ${this.name} is ${newPortNumber}`);
                this._ports[portType] = newPortNumber;
            }
            // the third case is that (the new port === the old port) and neither are null - we don't log anything in this case.
            return true;
        }
        // Log.d(`${portType} port is already ${currentPort}`);
        return false;
    }

    private setContainerID(newContainerID: string | undefined): boolean {
        const oldContainerID = this._containerID;
        this._containerID = newContainerID;

        const changed = this._containerID !== oldContainerID;
        if (changed) {
            const asStr: string = this._containerID == null ? "undefined" : this._containerID.substring(0, 8);
            if (asStr.length === 0) {
                Log.w(`Empty containerID for ${this.name}`);
            }
            Log.d(`New containerID for ${this.name} is ${asStr}`);
        }
        return changed;
    }

    private setLastBuild(newLastBuild: number | undefined): boolean {
        if (newLastBuild == null) {
            return false;
        }
        const oldlastBuild = this._lastBuild;
        this._lastBuild = new Date(newLastBuild);

        const changed = this._lastBuild !== oldlastBuild;
        if (changed) {
            // Log.d(`New lastBuild for ${this.name} is ${this._lastBuild}`);
        }
        return changed;
    }

    private setLastImgBuild(newLastImgBuild: number | undefined): boolean {
        if (newLastImgBuild == null) {
            return false;
        }
        const oldlastImgBuild = this._lastImgBuild;
        this._lastImgBuild = new Date(newLastImgBuild);

        const changed = this._lastImgBuild !== oldlastImgBuild;
        if (changed) {
            // Log.d(`New lastImgBuild for ${this.name} is ${this._lastImgBuild}`);
        }
        return changed;
    }

    public setAutoBuild(newAutoBuild: boolean | undefined): boolean {
        if (newAutoBuild == null) {
            return false;
        }
        const oldAutoBuild = this._autoBuildEnabled;
        this._autoBuildEnabled = newAutoBuild;

        const changed = this._autoBuildEnabled !== oldAutoBuild;
        if (changed) {
            // onChange has to be invoked explicitly because this function can be called outside of update()
            Log.d(`New autoBuild for ${this.name} is ${this._autoBuildEnabled}`);
            this.onChange();
        }

        return changed;
    }

    public async setInjectMetrics(newInjectMetrics: boolean | undefined): Promise<boolean> {
        if (newInjectMetrics == null) {
            return false;
        }
        const oldInjectMetrics = this._injectMetricsEnabled;
        this._injectMetricsEnabled = newInjectMetrics;

        const changed = this._injectMetricsEnabled !== oldInjectMetrics;
        if (changed) {
            // onChange has to be invoked explicitly because this function can be called outside of update()
            Log.d(`New autoInjectMetricsEnabled for ${this.name} is ${this._injectMetricsEnabled}`);
            this.updateMetricsAvailable();
        }
        return changed;
    }

    public async tryOpenSettingsFile(): Promise<void> {
        const settingsFilePath = path.join(this.localPath.fsPath, Constants.PROJ_SETTINGS_FILE_NAME);
        let settingsFileExists: boolean;
        try {
            await fs.promises.access(settingsFilePath);
            settingsFileExists = true;
        }
        catch (err) {
            settingsFileExists = false;
        }

        if (settingsFileExists) {
            vscode.commands.executeCommand(Commands.VSC_OPEN, vscode.Uri.file(settingsFilePath));
        }
        else if (this.type.isExtensionType) {
            // this is expected; https://github.com/eclipse/codewind/issues/649
            vscode.window.showWarningMessage(`Application settings cannot be configured for ${this.type.toString()} projects.`);
        }
        else {
            // fall-back in case the user deleted the file, or something.
            vscode.window.showWarningMessage(`${settingsFilePath} does not exist or was not readable.`);
        }
    }

    /**
     * Extra test for extension projects app monitor - workaround for https://github.com/eclipse/codewind/issues/258
     */
    public async testPingAppMonitor(): Promise<boolean> {
        if (this.type.type !== ProjectType.Types.EXTENSION_APPSODY) {
            // this test is not necessary for non-appsody projects
            return true;
        }

        if (this.appMonitorUrl == null) {
            return false;
        }

        Log.i(`Testing extension project's app monitor before opening`);
        try {
            await request.get(this.appMonitorUrl, { rejectUnauthorized: false });
            return true;
        }
        catch (err) {
            Log.w(`Failed to access app monitor for project ${this.name} at ${this.appMonitorUrl}`, err);
            // cache this so we don't have to do this test every time.
            this._metricsAvailable = false;
            // Notify the treeview that this project has changed so it can hide these context actions
            this.onChange();
            return false;
        }
    }
}
