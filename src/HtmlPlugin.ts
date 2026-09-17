import { addIcon, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { HtmlView, showError, HTML_FILE_EXTENSIONS, ICON_HTML, VIEW_TYPE_HTML } from './HtmlView';
import { HtmlPluginSettings, HtmlSettingTab, DEFAULT_SETTINGS } from './HtmlPluginSettings';
import { ScrollMemory } from './ScrollMemory';

// Version bumped to 1.0.17 to verify BRAT picks up new releases. No behavior change.
export default class HtmlPlugin extends Plugin {
	settings!: HtmlPluginSettings;
	scrollMemory!: ScrollMemory;
	
	async onload() {
		await this.loadSettings();
		this.scrollMemory = new ScrollMemory(this.app);

		// Keep remembered scroll positions attached to files as they move or go away.
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile)
				this.scrollMemory.rename(oldPath, file.path);
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (file instanceof TFile)
				this.scrollMemory.remove(file.path);
		}));

		// Add your own icon: https://marcus.se.net/obsidian-plugin-docs/user-interface/icons#add-your-own-icon
		/*
		addIcon(ICON_HTML, `<circle cx="50" cy="50" r="50" fill="currentColor" />`);
		*/

		this.registerView(VIEW_TYPE_HTML, (leaf: WorkspaceLeaf) => {
			return new HtmlView(leaf, this.settings, this.scrollMemory);
		});

		try {
			this.registerExtensions(HTML_FILE_EXTENSIONS, VIEW_TYPE_HTML);
		} catch (error) {
			await showError(`File extensions ${HTML_FILE_EXTENSIONS} had been registered by other plugin!`);
		}
		
		this.addSettingTab(new HtmlSettingTab(this.app, this));
	}

	onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}