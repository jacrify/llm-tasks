// Mock stubs for the Obsidian API used by llm-tasks

export class Plugin {
  app: App;
  manifest: any;
  constructor(app?: any, manifest?: any) {
    this.app = app || new App();
    this.manifest = manifest || {};
  }
  async loadData(): Promise<any> { return {}; }
  async saveData(_data: any): Promise<void> {}
  addCommand(_command: any): any { return {}; }
  addSettingTab(_tab: any): void {}
  addStatusBarItem(): HTMLElement { return document.createElement("div"); }
  registerInterval(_id: number): number { return _id; }
}

export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

export class PluginSettingTab {
  app: App;
  plugin: any;
  containerEl: HTMLElement;
  constructor(app: App, plugin: any) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
  }
  display(): void {}
  hide(): void {}
}

export class Setting {
  settingEl: HTMLElement;
  constructor(_containerEl: HTMLElement) {
    this.settingEl = document.createElement("div");
  }
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  addText(_cb: (text: any) => any): this { return this; }
  addToggle(_cb: (toggle: any) => any): this { return this; }
  addDropdown(_cb: (dropdown: any) => any): this { return this; }
  addTextArea(_cb: (textArea: any) => any): this { return this; }
}

export class App {
  vault: Vault;
  workspace: Workspace;
  constructor() {
    this.vault = new Vault();
    this.workspace = new Workspace();
  }
}

export class TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  parent: any;
  stat: any;
  vault: any;
  constructor(path?: string) {
    this.path = path || "";
    this.name = path ? path.split("/").pop() || "" : "";
    this.basename = this.name.replace(/\.[^.]*$/, "");
    this.extension = this.name.includes(".") ? this.name.split(".").pop() || "" : "";
    this.parent = null;
    this.stat = { ctime: 0, mtime: 0, size: 0 };
  }
}

export class VaultAdapter {
  async read(_path: string): Promise<string> { return ""; }
  async write(_path: string, _data: string): Promise<void> {}
  getBasePath(): string { return "/mock-vault"; }
}

export class Vault {
  adapter: VaultAdapter;
  constructor() {
    this.adapter = new VaultAdapter();
  }
  async read(_file: TFile): Promise<string> { return ""; }
  async create(_path: string, _data: string): Promise<TFile> { return new TFile(_path); }
  async modify(_file: TFile, _data: string): Promise<void> {}
  getAbstractFileByPath(_path: string): TFile | null { return null; }
  async createFolder(_path: string): Promise<void> {}
  getRoot(): any { return { path: "/" }; }
}

export class Workspace {
  getActiveViewOfType(_type: any): any { return null; }
  on(_event: string, _callback: (...args: any[]) => any): any { return {}; }
  openLinkText(_linktext: string, _sourcePath: string): Promise<void> { return Promise.resolve(); }
}

export class Editor {
  getCursor(): { line: number; ch: number } { return { line: 0, ch: 0 }; }
  getLine(_line: number): string { return ""; }
  setLine(_line: number, _text: string): void {}
  lineCount(): number { return 1; }
  getValue(): string { return ""; }
}

export class MarkdownView {
  editor: Editor;
  file: TFile | null;
  constructor() {
    this.editor = new Editor();
    this.file = null;
  }
}

export class Modal {
  app: App;
  contentEl: HTMLElement;
  modalEl: HTMLElement;
  constructor(app: App) {
    this.app = app;
    this.contentEl = document.createElement("div");
    this.modalEl = document.createElement("div");
  }
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}
