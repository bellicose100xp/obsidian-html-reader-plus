import { App, PluginSettingTab, Setting } from "obsidian";
import HtmlPlugin from "./HtmlPlugin";

export interface HtmlPluginSettings {
	zoomByWheelAndGesture: boolean;
	zoomValue: number;
}

export const DEFAULT_SETTINGS: HtmlPluginSettings = {
	zoomByWheelAndGesture: true,
	zoomValue: 1.0,
}

export class HtmlSettingTab extends PluginSettingTab {
	app: App;
	plugin: HtmlPlugin;

	constructor(app: App, plugin: HtmlPlugin) {
		super(app, plugin);
		this.app = app;
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName( 'Quick document zoom in and out' )
			.setDesc( 'Zoom the document using Ctrl + Wheel (zoom in: ↑, zoom out: ↓), or using the trackpad/touch screen/touch panel two-finger pinch-zoom gesture (zoom in: ← →, zoom out: → ←).' )
			.addToggle( (toggle) => {
				toggle
					.setValue(this.plugin.settings.zoomByWheelAndGesture)
					.onChange( async (enabled: boolean) => {
						this.plugin.settings.zoomByWheelAndGesture = enabled;
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl('p', {
			text: 'Keyboard shortcuts come from Obsidian\'s own hotkey settings and work inside rendered files, so there is nothing to configure here. Files are rendered exactly as written, with no sanitizing or script stripping.',
			cls: 'setting-item-description',
		});
	}
}

// https://forum.obsidian.md/t/identify-platform-operating-system/27878/3
export function isMacPlatform(): boolean {
	const macosPlatforms = ['Macintosh', 'MacIntel', 'MacPPC', 'Mac68K'];
	if( macosPlatforms.indexOf(window.navigator.platform) !== -1 )
		return true;
	return false;
}
export function isIosPlatform(): boolean {
	const iosPlatforms = ['iPhone', 'iPad', 'iPod'];
	const userAgent = window.navigator.userAgent;
	for( let plat of iosPlatforms )
		if( userAgent.contains(plat) )
			return true;
	return false;
}
