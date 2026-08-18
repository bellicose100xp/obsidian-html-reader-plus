import { WorkspaceLeaf, FileView, TFile, setIcon, Notice } from "obsidian";
import { HtmlPluginSettings, isMacPlatform, isIosPlatform } from './HtmlPluginSettings';

import { extract } from "single-filez-core/processors/compression/compression-extract.js";
import * as zip from  '@zip.js/zip.js';
import Mark from 'mark.js';
import NP from 'number-precision'

export const HTML_FILE_EXTENSIONS = ["html", "htm"];
export const VIEW_TYPE_HTML = "html-view";
export const ICON_HTML = "doc-html";


export class HtmlView extends FileView {
	settings: HtmlPluginSettings;
	mainView!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private settings: HtmlPluginSettings) {
		super(leaf);
		this.settings = settings;
	}
  
	async onLoadFile(file: TFile): Promise<void> {
		// const style = getComputedStyle(this.containerEl.parentElement.querySelector('div.view-header'));
		// const width = parseFloat(style.width);
		// const height = parseFloat(style.height);
		// const tocOffset = height < width ? height : 0;
	
		this.contentEl.empty();
	
		try {
			// whole HTML file ArrayBuffer
			const contents = await this.app.vault.readBinary(file);
			
			// Obsidian's HTMLElement and Node API: https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
			
			let htmlStr = null;

			try {
				// the HTML file made by SingleFileZ
				globalThis.zip = zip;
				const { docContent } = await extract(new Blob([new Uint8Array(contents)]), { noBlobURL: true });

				htmlStr = docContent;
			} catch {
				// the HTML file not made by SingleFileZ
				const decoder = new TextDecoder();
				htmlStr = decoder.decode(contents); // decode with UTF8
			}
			
			// https://github.com/nefe/number-precision
			NP.enableBoundaryChecking(false); // default param is true
			
			this.mainView = this.contentEl.createDiv();
			this.mainView.setAttribute( "style", "display: flex; flex-direction: column; height: 100%; padding: 0;" );
			this.mainView.innerHTML = MAINVIEW_HTML; // direct assign safe HTML code
			const searchBar = this.mainView.querySelector( "#ohpMainView" );
			const iframe = this.mainView.querySelector( "#ohpIframe" );
			const baseHref = getHtmlBaseHref(this.app, file);
			
			// Render the file exactly as written: no sanitizing, no script stripping, no CSP.
			// The only change is a <base href> so relative links and assets resolve against
			// the file's own folder.
			iframe.srcdoc = injectBaseHrefToHtml(htmlStr, baseHref);

			iframe.mainView = this.mainView;
			this.mainView.app = this.app;
			this.mainView.settings = this.settings;
			this.mainView.searchBar = searchBar;
			this.mainView.iframe = iframe;
			iframe.onload = async function() {
				// fix some behaviors for consistency with Shadow DOM and Obsidian
				applyUserInteractivePatches( iframe.contentDocument );
				await modifyAnchorTarget( iframe.contentDocument );
				iframe.contentWindow.addEventListener( 'click', sdFixAnchorClickHandler );

				await restoreStateBySettings( iframe.contentWindow.document, iframe.mainView.settings );
				buildUserInteractiveFacilities( iframe.mainView );
				
				// bubble iframe's 'keydown' event to parent (issue #16)
				iframe.contentWindow.addEventListener( 'keydown', (evt) => {
					iframe.dispatchEvent( new evt.constructor(evt.type, evt) );
				}, false );

				installObsidianDomExtensions( iframe );
				forwardHotkeysToObsidian( iframe );
			};
			
			dispatchEvent(new CustomEvent("DOMContentLoaded"));
		
		} catch (error) {
			showError(error);
		}
	}

	onunload(): void {
	}
	
	onPaneMenu(menu: Menu, source: 'more-options' | 'tab-header' | string): void {
		if( source !== 'more-options' ) // only handle 'more-options' onMoreOptionsMenu()
			return;

		menu.addItem((item) => {
			item
				.setTitle( i18next.t("interface.menu.find") )
				.setIcon( "lucide-search" )
				.onClick(async () => {
					this.mainView.openSearch();
				} );
		});
		menu.addItem((item) => {
			item
				.setTitle( i18next.t("commands.zoom-in") )
				.setIcon( "plus-with-circle" )
				.onClick( async () => {
					 this.mainView.ZoomIn();
				} );
		});
		menu.addItem((item) => {
			item
				.setTitle( i18next.t("commands.zoom-out") )
				.setIcon( "minus-with-circle" )
				.onClick( async () => {
					 this.mainView.ZoomOut();
				} );
		});
		menu.addItem((item) => {
			item
				.setTitle( i18next.t("commands.reset-zoom") )
				.setIcon( "reset" )
				.onClick( async () => {
					 this.mainView.ResetZoom();
				} );
		});
		
		menu.addSeparator();
		super.onPaneMenu(menu, source);
	}

	canAcceptExtension(extension: string) {
		return HTML_FILE_EXTENSIONS.includes(extension);
	}

	getViewType() {
		return VIEW_TYPE_HTML;
	}

	getIcon() {
		// built-in icons list: https://forum.obsidian.md/t/list-of-available-icons-for-component-seticon/16332
		return "code-glyph";  // </>
	}
}

function getHtmlBaseHref(app: App, file: TFile): string {
	try {
		const resourcePath = app?.vault?.getResourcePath(file);
		return resourcePath || "";
	} catch {
		return "";
	}
}

function ensureBaseHref(doc: Document, baseHref: string): void {
	if (!doc?.head || !baseHref) return;
	let baseElm = doc.querySelector("base");
	if (!baseElm) {
		baseElm = doc.createElement("base");
		doc.head.prepend(baseElm);
	}
	baseElm.setAttribute("href", baseHref);
}

function injectBaseHrefToHtml(htmlStr: string, baseHref: string): string {
	if (!htmlStr || !baseHref) return htmlStr;
	try {
		const doc = (new window.DOMParser()).parseFromString(htmlStr, "text/html");
		ensureBaseHref(doc, baseHref);
		return doc.documentElement.outerHTML;
	} catch {
		return htmlStr;
	}
}

export async function showError(e: Error | any): Promise<void> {
	const notice = new Notice("", 8000);
	// @ts-ignore
	notice.noticeEl.createEl('strong', { text: 'HTML Reader error' });
	notice.noticeEl.createDiv({ text: `${e.message}` });
}

// while clicking, fix internal links(in-page anchor) replaced by Shadow Root and IFrame at runtime
function sdFixAnchorClickHandler( evt ) {
	
	const aElm = evt.composedPath().find( elm => elm.nodeName === 'A' );
	const regex = /href\s*=\s*['"]\s*#/igm; // Regex for checking <a href="#xxx">
	
	// ignore non-internal link
	if( !aElm || !aElm.href || !regex.test(aElm.outerHTML) )
		return;
	
	const rootNode = aElm.getRootNode();
	if( !aElm.hash || aElm.hash.length <= 1 ) {
		// aElm.hash may be empty when hash == "#"
		if( rootNode.location )
			rootNode.location.hash = '#';
		else
			rootNode.scrollTop = 0;
	} else {
		const idInternal = decodeURIComponent( aElm.hash.slice(1) );
		const targetElm = rootNode.getElementById( idInternal );
		if( targetElm ) {
			if( rootNode.location ) {
				rootNode.location.hash = idInternal;
			} else {
				// this method could not trigger the :target CSS pseudo-class event
				targetElm.scrollIntoView();
			}
		}
	}
	
	evt.preventDefault();
}

// Give the iframe realm the DOM prototype helpers Obsidian expects on every element.
//
// Obsidian's enhance layer adds Node.instanceOf(), Element.hasClass(), and the
// doc/win/constructorWin accessors to the windows it manages (the main window and
// pop-outs), and core code calls them on any element it touches. The iframe is a
// realm Obsidian doesn't manage, yet its elements do reach core code: when a modal
// opens while focus is inside the iframe, Modal.open() stores
// iframe.contentDocument.activeElement for focus restore, and Modal.close() calls
// focusEl.instanceOf(HTMLElement) on it. Without these helpers that call throws,
// killing the rest of the close handler — picking a file in the Quick Switcher
// dismissed the modal but never opened the chosen file. The definitions mirror
// enhance.js, including instanceOf's resolve-by-class-name across realms.
function installObsidianDomExtensions( iframe: any ) {
	const frameWin = iframe.contentWindow;
	if( !frameWin || frameWin.Node.prototype.instanceOf )
		return;

	const nodeProto = frameWin.Node.prototype;
	Object.defineProperty( nodeProto, 'doc', {
		configurable: true,
		get: function() { return this.ownerDocument || frameWin.document; },
	} );
	Object.defineProperty( nodeProto, 'win', {
		configurable: true,
		get: function() { return this.doc.defaultView || frameWin; },
	} );
	nodeProto.constructorWin = frameWin;
	nodeProto.instanceOf = function( cls: any ) {
		if( this instanceof cls )
			return true;
		let own = this.win[cls.name];
		return !!(own && this instanceof own) || !!((own = this.constructorWin[cls.name]) && this instanceof own);
	};
	frameWin.Element.prototype.hasClass = function( cls: string ) {
		return this.classList.contains( cls );
	};
}

// Hand every keystroke that happens inside the iframe to Obsidian's hotkey manager.
//
// The bubble-phase re-dispatch above is enough for ordinary pages, but a page that runs
// its own scripts can register a capture-phase keydown listener and call
// stopImmediatePropagation(), which kills the event before anything else sees it. That
// silently breaks every Obsidian shortcut while such a file is open. Registering our own
// capture listener does not help: the page's listener was registered first, and
// stopImmediatePropagation() drops the remaining listeners on the same target and phase.
//
// So we make keyboard events unstoppable inside the iframe realm and forward a copy to
// app.keymap.onKeyEvent(), which is the same entry point Obsidian uses for webviews.
// Only KeyboardEvent is affected, so a page's mouse and touch handling is left intact.
function forwardHotkeysToObsidian( iframe: any ) {
	const frameWin = iframe.contentWindow;
	if( !frameWin )
		return;

	const keymap = iframe.mainView?.app?.keymap;
	if( !keymap?.onKeyEvent )
		return;

	// let keyboard events run their full path even if the page tries to cut them short
	const proto = frameWin.Event.prototype;
	const stopPropagation = proto.stopPropagation;
	const stopImmediatePropagation = proto.stopImmediatePropagation;
	proto.stopPropagation = function() {
		if( !(this instanceof frameWin.KeyboardEvent) )
			stopPropagation.call( this );
	};
	proto.stopImmediatePropagation = function() {
		if( !(this instanceof frameWin.KeyboardEvent) )
			stopImmediatePropagation.call( this );
	};

	frameWin.addEventListener( 'keydown', (evt: KeyboardEvent) => {
		// a page's own text inputs keep their keystrokes, otherwise typing in an
		// embedded search box would trigger single-key Obsidian hotkeys
		const target = evt.target as HTMLElement | null;
		if( target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '') )
			return;

		// rebuild in the host realm, Obsidian's keymap reads instanceof against its own window
		keymap.onKeyEvent( new KeyboardEvent('keydown', {
			key: evt.key,
			code: evt.code,
			ctrlKey: evt.ctrlKey,
			shiftKey: evt.shiftKey,
			altKey: evt.altKey,
			metaKey: evt.metaKey,
			repeat: evt.repeat,
			bubbles: true,
			cancelable: true,
		}) );
	}, true );
}

function applyUserInteractivePatches( doc: HTMLDocument ) {
	if( !doc.body.style ) {
		doc.body.setAttribute( 'style', "overflow-x: clip; overflow-y: visible; user-select: text; max-width: 100%; word-wrap: break-word;" );
		return;
	}
	
	// Keep wide content from scrolling sideways without breaking 'position: sticky'.
	//
	// 'overflow-x: hidden' cannot be used here. Per the CSS overflow spec a non-visible
	// value on one axis computes the other axis away from 'visible', so hiding the
	// horizontal axis alone yields 'overflow: hidden visible' and makes <body> a scroll
	// container. Sticky children then resolve against that box instead of the iframe
	// viewport, and page headers meant to stay pinned scroll out of view.
	//
	// 'clip' does the same visual clipping but explicitly does not create a scroll
	// container, and it is the one non-visible value that may pair with 'visible' on the
	// other axis. That keeps <body> out of the way so the iframe viewport stays the
	// scrollport that sticky resolves against.
	if( doc.body.style.overflow === '' ) {
		doc.body.style.overflowX = 'clip';
		doc.body.style.overflowY = 'visible';
	}
	// avoid horizontal overflow on any element
	if( doc.body.style.maxWidth === '' )
		doc.body.style.maxWidth = '100%';
	// avoid some HTML files unable to select text, only when 'user-select' is not set
	if( doc.body.style.userSelect === '' )
		doc.body.style.userSelect = 'text';
	
	// also constrain html root element, again with 'clip' so the root keeps scrolling
	// vertically and stays the scrollport for sticky elements
	if( doc.documentElement.style.overflowX === '' )
		doc.documentElement.style.overflowX = 'clip';
}

// Unused: this fork renders files as written, so nothing strips scripts. Kept as the
// starting point for a "strip scripts" option if one is ever wanted.
async function removeScriptTagsAndExtScripts( doc: HTMLDocument ): Promise<void> {
	let allNodes = doc.querySelectorAll( 'script' );
	for( var node of allNodes ) {
		node.parentNode.removeChild( node );
	}
	
	allNodes = doc.querySelectorAll( 'link' );
	for( var node of allNodes ) {
		if( !node.rel )
			continue;
		
		if( node.rel.contains('script') )
			node.parentNode.removeChild( node );
		else if( node.rel.contains('preload') && node.as && node.as.contains('script') )
			node.parentNode.removeChild( node );
	}
}

async function modifyAnchorTarget( doc: HTMLDocument ): Promise<void> {
	let baseElm = doc.querySelector( 'base' );
	if( !baseElm ) {
		baseElm = doc.createElement( 'base' );
		doc.head.appendChild( baseElm );
	}
	
	// force modify <base>'s target to "_blank" for IFrame
	baseElm.target = "_blank";
		
	const regex = /href\s*=\s*['"]\s*#/igm; // Regex for checking <a href="#xxx">
	// force modify <a>'s target to "_blank" for IFrame
	const aElms = doc.querySelectorAll( 'a' );
	for( const aElm of aElms ) {
		if( aElm.target === '_self' )
			aElm.target = '_blank';
			
		if( !aElm.href )
			continue;
			
		// internal links are prefix with follow:
		// 1. app://obsidian.md/index.html#xxxxx at Desktop version of Obsidian
		// 2. http://localhost/#xxxxx at Mobile version of Obsidian
		if( !regex.test(aElm.outerHTML) ) {
			// external links
			if( !aElm.rel ) {
				aElm.rel = "noopener noreferrer";
			} else {
				if( !aElm.rel.contains('noopener') )
					aElm.rel += ' noopener';
				if( !aElm.rel.contains('noreferrer') )
					aElm.rel += ' noreferrer';
			}

			// Open a relative file in new Tab, Feature Request #27
			// TODO: specific file formats?
			// TODO: check if the href is a relative resource
			aElm.addEventListener( 'click', (evt: KeyboardEvent | MouseEvent) => {
				if( evt.ctrlKey ) {
					evt.preventDefault();
					app.workspace.openLinkText( aElm.getAttribute('href'), '', true );
				}
			});
		}
	}
}

// Apply the zoom level to the rendered document.
//
// A transform on <html> makes it the containing block for its descendants, which turns
// 'position: fixed' into something that behaves like 'position: absolute': fixed sidebars
// and floating back-to-top buttons scroll away with the content instead of staying put.
// At the default zoom the transform is pure overhead, so leave it off entirely and let
// fixed elements resolve against the viewport the way they do in a browser.
function applyZoom( doc: HTMLDocument, zoomValue: number ) {
	const root = doc.all[0] as HTMLElement;
	if( zoomValue === 1 ) {
		root.style.removeProperty( 'transform' );
		root.style.removeProperty( 'transform-origin' );
		return;
	}

	root.style.transformOrigin = "left top"; // CSS transform-origin
	root.style.transform = `scale(${zoomValue})`;
}

async function restoreStateBySettings( doc: HTMLDocument, settings: HtmlPluginSettings ): Promise<void> {
	// all[0] ==> <html>
	applyZoom( doc, settings.zoomValue );
}

function isUnselectableElement( elm: HTMLElement ): boolean {
	var style = getComputedStyle(elm);
	return ((style.display === 'none') || (elm.offsetWidth === 0))
}

let isAppleSys = isMacPlatform() || isIosPlatform();
function mapNativeHotkeys( app: App, cmdId: string ): Hotkey[] {
	const appAny = app as App & { hotkeyManager?: any };
	const manager = appAny.hotkeyManager;
	let ohks = manager?.getHotkeys?.(cmdId) || manager?.getDefaultHotkeys?.(cmdId);

	const nhks: Hotkey[] = [];
	if( !ohks || ohks.length <= 0 )
		return nhks;
		
	const nhksNoMod: Hotkey[] = [];
	for( let ohk of ohks ) {
		const hk = new Hotkey();
		hk.key = ohk.key;
		hk.modifiers = [];
		if( ohk.modifiers && ohk.modifiers.length > 0 ) {
			for( let mod of ohk.modifiers ) {
				if( mod === 'Mod' ) {
					// replace Obsidian's Mod modifier string to native platform's modifier
					hk.modifiers.push( isAppleSys ? 'Meta' : 'Ctrl' );
				} else {
					hk.modifiers.push( mod );
				}
			}
			nhks.push( hk );
		} else {
			nhksNoMod.push( hk );
		}
	}
	
	return nhks.concat(nhksNoMod); 
}

function checkHotkeyModifier( modifiers: Modifier[], evt: KeyboardEvent | MouseEvent ): boolean {
	if( !modifiers || modifiers.length <= 0 )
		return true;
	
	// https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/getModifierState
	// https://w3c.github.io/uievents-key/#keys-modifier
	// https://github.com/obsidianmd/obsidian-api/blob/bceb489fc25ceba5973119d6e57759d64850f90d/obsidian.d.ts#L2498
	for( let mod of modifiers ) {
		switch( mod ) {
			case 'Ctrl': // Ctrl = Ctrl key for every OS
				if( !evt.ctrlKey )
					return false;
				break;
			case 'Meta': // Meta = Cmd on MacOS and Win key on other OS
				// This key value is used for the "Windows Logo" key and the Apple Command or ⌘ key. 
				if( !evt.metaKey )
					return false;
				break;
			case 'Shift':
				if( !evt.shiftKey )
					return false;
				break;
			case 'Alt':
				if( !evt.altKey ) // This key value is also used for the Apple Option key. 
					return false;
				break;
			case 'Mod': // Mod = Cmd on MacOS/iOS/iPadOS and Ctrl on other OS
				if( isAppleSys ? !evt.metaKey : !evt.ctrlKey)
					return false;
				break;
		}
	}
	return true;
}

async function buildUserInteractiveFacilities( mainView: HTMLElement ): Promise<void> {
	const searchBar: HTMLElement = mainView.searchBar;
	const iframe: HTMLElement = mainView.iframe;
	const settings: HtmlPluginSettings = mainView.settings;
	
	let isSearchBarVisible: boolean = false, hltAllNodes: boolean = false;
	let curText: string;
	let curIndex: number = -1;
	
	const allMatched = []; // array of array of mark element(s)
	const tmpMatched = []; // array of temp. mark elements for combining later
	const mark = new Mark( iframe.contentWindow.document.body );
	const addMatched = (node) => {
		if( isUnselectableElement(node.parentElement) )
			return;
		
		if( node.textContent && node.textContent.length != curText.length ) {
			if( tmpMatched.length <= 0 ) {
				tmpMatched.push( new Array(node) );
				return;
			}
			
			// check existed tmpMatched array
			let tmpText = "";
			for( let idx = 0; idx < tmpMatched.length; ++idx ) {
				tmpText += tmpMatched[idx].textContent;
				let tmpText2 = tmpText + node.textContent;
				if( tmpText2.length === curText.length ) {
					if( tmpText2.toLowerCase() === curText ) {
						// found all matched elements, then put them to allMatched
						let tmpMA = [];
						for( let i = 0; i <= idx; ++i )
							tmpMA.push( tmpMatched[i] );
							
						tmpMA.push( node );
						allMatched.push( tmpMA );
					} 
					
					// remove compared elements
					for( let i = 0; i <= idx; ++i )
						tmpMatched.shift();
					break;
				}
			}
		} else {
			allMatched.push( new Array(node) );
		}
	}
	const obsOpt = { 
		"element": "span",
		"className": `ohp-temp-search-class ${HIGHLIGHT_CLASS_NAME}`,
		"separateWordSearch": false,
		"acrossElements": true,
		"each" : addMatched
	};
	const tmpOpt = { 
		"element": "span",
		"className": `ohp-temp-search-class`,
		"separateWordSearch": false,
		"acrossElements": true,
		"each" : addMatched
	};
	
	const clearObsMark = (array) => {
		if( !array || array.length <= 0 ) 
			return;
		
		for( let elm of array ) {
			if( elm.classList.contains( HIGHLIGHT_CLASS_NAME ) )
				elm.classList.remove( HIGHLIGHT_CLASS_NAME );
				// elm.classList.toggle( HIGHLIGHT_CLASS_NAME );
		}
	};
	const setObsMark = (array) => {
		if( !array || array.length <= 0 ) 
			return;
			
		for( let elm of array ) {
			if( !elm.classList.contains( HIGHLIGHT_CLASS_NAME ) )
				elm.classList.add( HIGHLIGHT_CLASS_NAME );
		}
	};
	const clearAllMarks = (includeTags) => {
		if( includeTags ) {
			mark.unmark( obsOpt );
			mark.unmark( tmpOpt );
			hltAllNodes = false;
		} else {
			for( const elm of allMatched ) {
				clearObsMark( elm );
			}
		}
		hltAllNodes = false;
	};
	const setAllMarks = (includeObs) => {
		if( allMatched.length <= 0 ) {
			if( includeObs )
				mark.mark( curText, obsOpt );
			else
				mark.mark( curText, tmpOpt );
		} else if( includeObs ) {
			for( const elm of allMatched ) {
				setObsMark( elm );
			}
		}
		
		if( allMatched.length > 0 )
			hltAllNodes = true;
	};
	const toggleInputError = (showError) => {
		if( showError ) {
			clearAllMarks( true );
			if( !input.classList.contains( "mod-no-match" ) )
				input.classList.add( "mod-no-match" );
		} else {
			if( input.classList.contains( "mod-no-match" ) )
				input.classList.remove( "mod-no-match" );
		}
	};
	const findNext = () => {
		if( hltAllNodes )
			clearAllMarks( false );
			
		// no matched
		if( !curText || allMatched.length <= 0 )
			return;
		
		// unmark old node
		if( curIndex >= 0 && curIndex < allMatched.length )
			clearObsMark( allMatched[curIndex] );
		
		if( curIndex + 1 >= allMatched.length )
			curIndex = 0;
		else
			curIndex++;
			
		setObsMark( allMatched[curIndex] );
		(allMatched[curIndex])[0].scrollIntoView( { behavior: 'smooth', block: 'center' } );
	};
	const findPrev = () => {
		if( hltAllNodes )
			clearAllMarks( false );
		 
		// no matched
		if( !curText || allMatched.length <= 0 )
			return;
		
		// unmark old node
		if( curIndex >= 0 && curIndex < allMatched.length )
			clearObsMark( allMatched[curIndex] );
		
		if( curIndex - 1 < 0 )
			curIndex = allMatched.length - 1;
		else
			curIndex--;
		
		setObsMark( allMatched[curIndex] );
		(allMatched[curIndex])[0].scrollIntoView( { behavior: 'smooth', block: 'center' } );
	};
	
	// mark all searching text with tmpOpt/obsOpt
	const findAll = (text, markAll, selObj) => {
		clearAllMarks( true );
		
		allMatched.length = 0; // clear array to empty
		tmpMatched.length = 0;
		curText = text;
		if( markAll )
			mark.mark( curText, obsOpt );
		else 
			mark.mark( curText, tmpOpt );
			
		if( allMatched.length <= 0 ) {
			toggleInputError( true ); // found nothing
		} else {
			// update curIndex
			if( curIndex > allMatched.length )
				curIndex = allMatched.length - 1;
			else if( selObj && selObj.anchorNode ) {
				// select nearest element as curIndex
				const sibNode = selObj.anchorNode.nextElementSibling || selObj.anchorNode.parentElement;
				if( sibNode && sibNode.nodeName === 'SPAN' && sibNode.classList.contains('ohp-temp-search-class') ) {
					for( let idx = 0; idx < allMatched.length; ++idx ) {
						for( let node of allMatched[idx] ) {
							if( node.isSameNode(sibNode) ) { // found next node
								if( idx >= 1 )
									curIndex = idx - 1;
								else 
									curIndex = idx;
								return;
							}
						}
					}
				}
			}
		}
	};
	
	const checkAndUpdateMatches = () => {
		let newText = input.value.trim().toLowerCase();
		if( newText === curText )
			return;
		
		// newText !== curText, so update related bookkeeping data
		toggleInputError( false );
		if( !newText ) {
			// newText is null or an empty string
			clearAllMarks( true );
		} else {
			findAll( newText, false );
		}
		curText = newText;
	};
	
	const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
	iframe.contentWindow.focus();
	
	// add MenuItem polyfill methods
	mainView.openSearch = () => {
		searchBar.style.display = 'inherit'; // show Search box
		isSearchBarVisible = true;
		input.focus();
		
		let newText = curText;
		const selObj = iframe.contentWindow.getSelection();
		if( selObj ) // get selected text for newText
			newText = selObj.toString().trim().toLowerCase();
		
		let reIndex = false;
		if( newText && newText !== curText ) {
			findAll( newText, false, selObj );
			reIndex = true;
		}			
		
		if( !curText )
			return;
		
		input.value = curText;
		if( reIndex ) {
			// search new text
			findNext();
			return;
		}
		
		if( hltAllNodes ) {
			setAllMarks( true );
		} else if( curIndex >= 0 && curIndex < allMatched.length ) {
			setObsMark( allMatched[curIndex] );
			(allMatched[curIndex])[0].scrollIntoView( { behavior: 'smooth', block: 'center' } );
		}
	};
	mainView.ZoomIn = () => {
		settings.zoomValue = NP.plus( settings.zoomValue, 0.1 );
		applyZoom( iframeDoc, settings.zoomValue );
		iframe.contentWindow.focus();
	};
	mainView.ZoomOut = () => {
		let scaleValue = NP.minus( settings.zoomValue, 0.1 );
		if( scaleValue <= 0.1 )
			scaleValue = 0.1;
		settings.zoomValue = scaleValue;
		applyZoom( iframeDoc, settings.zoomValue );
		iframe.contentWindow.focus();
	};
	mainView.ResetZoom = () => {
		settings.zoomValue = 1.0;
		applyZoom( iframeDoc, settings.zoomValue );
		iframe.contentWindow.focus();
	};
	
	// build hotkeys from Obsidian's global hotkeys settings
	const hksSearch = mapNativeHotkeys( mainView.app, 'editor:open-search' );
	const hksZoomIn = mapNativeHotkeys( mainView.app, 'window:zoom-in' );
	const hksZoomOut = mapNativeHotkeys( mainView.app, 'window:zoom-out' );
	const hksResetZoom = mapNativeHotkeys( mainView.app, 'window:reset-zoom' );
	
	// add event handlers
	const input = searchBar.querySelector( '#ohpSearchInput' );
	input.addEventListener( 'keyup', (evt) => {
		if( (evt.altKey && evt.keyCode === 13) ) { // handle "select all" command when press Alt+Enter
			sall.click();
		}		
		else if( evt.keyCode === 13 ) { // when press Enter key then perform search next
			next.click();
		}
	} );
	const next = searchBar.querySelector( '#ohpSearchNext' );
	next.addEventListener( 'click', (evt) => {
		checkAndUpdateMatches();
		findNext();
	} );
	setIcon( next, 'lucide-arrow-down' );
	const prev = searchBar.querySelector( '#ohpSearchPrev' );
	prev.addEventListener( 'click', (evt) => {
		checkAndUpdateMatches();
		findPrev();
	} );
	setIcon( prev, 'lucide-arrow-up' );
	const sall = searchBar.querySelector( '#ohpSearchSelectAll' );
	sall.addEventListener( 'click', (evt) => {
		checkAndUpdateMatches();
		if( !curText ) {
			clearAllMarks( true );
		} else {
			setAllMarks( true );
		}
	} );
	setIcon( sall, 'lucide-text-select' );
	const exit = searchBar.querySelector( '#ohpSearchExit' );
	exit.addEventListener( 'click', (evt) => {
		// clear highlight marks, but keep curText and tmp class
		let preAllNodes = hltAllNodes;
		clearAllMarks( false );
		hltAllNodes = preAllNodes;
		
		searchBar.style.display = 'none'; // hide Search bar
		isSearchBarVisible = false;
		iframe.contentWindow.focus();
	} );
	setIcon( exit, 'lucide-x' );
	searchBar.addEventListener( 'keydown', (evt) => {
		if( evt.shiftKey && evt.keyCode === 114 ) {
			// search previous Shift+F3
			prev.click();
		}
		
		// else if( evt.keyCode === 114 ) {
		else if( evt.key === 'F3' ) {
			// search next F3
			next.click();
		}
		else if( evt.key === 'Escape' ) {
			// close search box
			exit.click();
		}
	} );
	
	iframe.contentWindow.addEventListener( 'keydown', (evt) => {
		if( evt.shiftKey && evt.keyCode === 114 ) {
			// search previous Shift+F3
			if( isSearchBarVisible )
				prev.click();
		}		
		else if( evt.altKey && evt.keyCode === 13 ) {
			// search select all Alt+Enter
			if( isSearchBarVisible )
				sall.click();
		}
		else if( evt.key === 'F3' ) {
			// search next F3
			if( isSearchBarVisible )
				next.click();
		}	
		else if( evt.key === 'F5' ) {
			// Refresh whole HTML page, Feature request #28
			//app.workspace.activeLeaf.rebuildView(); // OBSOLETE
			this.app.workspace.getActiveViewOfType(HtmlView)?.leaf.rebuildView();
		}
		else if( evt.key === 'Escape' ) {
			// close search bar
			if( isSearchBarVisible )
				exit.click();
		}
		
		else {
			// ignore Mod keys
			switch( evt.key ) {
				case 'Control':
				case 'Meta':
				case 'Shift':
				case 'Alt':
					return;
			}
			
			const ek = evt.key.toUpperCase();
			// match other
			if( hksSearch && hksSearch.length > 0 ) {
				for( let hk of hksSearch ) {
					if( checkHotkeyModifier(hk.modifiers, evt) && ek === hk.key ) {
						evt.preventDefault();
						mainView.openSearch();
						return;
					}
				}
			}
			
			if( hksZoomIn && hksZoomIn.length > 0 ) {
				for( let hk of hksZoomIn ) {
					if( checkHotkeyModifier(hk.modifiers, evt) && ek === hk.key ) {
						evt.preventDefault();
						mainView.ZoomIn();
						return;
					}
				}
			}
			
			if( hksZoomOut && hksZoomOut.length > 0 ) {
				for( let hk of hksZoomOut ) {
					if( checkHotkeyModifier(hk.modifiers, evt) && ek === hk.key ) {
						evt.preventDefault();
						mainView.ZoomOut();
						return;
					}
				}
			}
			
			if( hksResetZoom && hksResetZoom.length > 0 ) {
				for( let hk of hksResetZoom ) {
					if( checkHotkeyModifier(hk.modifiers, evt) && evt.key === hk.key ) {
						evt.preventDefault();
						mainView.ResetZoom();
						return;
					}
				}
			}
		}
	});
	
	// insert HIGHLIGHT_STYLE into HTMLDocument
	let hlt_style = iframe.contentDocument.createElement( 'style' );
	hlt_style.textContent = HIGHLIGHT_STYLE;
	if( iframe.contentDocument.body.children.length > 0 )
		iframe.contentDocument.body.insertBefore( hlt_style, iframe.contentDocument.body.children[0] );
	else
		iframe.contentDocument.body.appendChild( hlt_style );


	if( !settings.zoomByWheelAndGesture )
		return;
		
	// settings.zoomByWheelAndGesture is enabled
	iframe.contentWindow.addEventListener( 'wheel', (evt) => {
		if( !evt.ctrlKey )
			return;
		
		evt.preventDefault(); // prevent scrolling page	
		
		const cy = evt.clientY, py = evt.pageY, delta = evt.deltaY;
		let origPy = NP.divide( py, settings.zoomValue );
		if( delta < 0 )
			mainView.ZoomIn();
		else if( delta > 0 )
			mainView.ZoomOut();
		
		if( py > cy ) {
			iframe.contentWindow.scroll( { top: NP.minus(NP.times(origPy, settings.zoomValue), cy), behavior: "auto",} );
		}
	}, { passive: false });
	
	// cal. distance between two touch points
	const getTouchDistance = (touches) => {
		const touch1 = touches[0];
		const touch2 = touches[1];
		const dx = NP.minus(touch1.clientX, touch2.clientX);
		const dy = NP.minus(touch1.clientY, touch2.clientY);
		return Math.sqrt(dx * dx + dy * dy);
	};
	
	// let pointX: number = 0, pointY: number = 0, mouseX: number, mouseY: number;
	let pinchStartDistance: number = 0, pinchPageY: number = 0, pinchClientY = 0;
	let touchMoving: number = 0;
	iframe.contentWindow.addEventListener( 'touchstart', (evt) => {
		// only handle two finger gesture
		if( evt.touches.length === 2 ) {
			evt.preventDefault(); // prevent touchstart event
			pinchStartDistance = getTouchDistance( evt.touches );
			// set pinch start page/client y
			pinchClientY = NP.divide( NP.plus(evt.touches[0].clientY, evt.touches[1].clientY), 2 );
			pinchPageY =  NP.divide( NP.plus(evt.touches[0].pageY, evt.touches[1].pageY), 2 );
		}
	}, { passive: false });
	
	iframe.contentWindow.addEventListener( 'touchmove', (evt) => {
		if( evt.touches.length !== 2 ) // TouchEvent
			return;
			
		if( evt.cancelable ) {
			evt.preventDefault();
			evt.stopPropagation();
		}
		if( touchMoving++ !== 3 )
			return;
		touchMoving++;
		
		const pinchDistance = getTouchDistance( evt.touches );
		const cy = pinchClientY, py = pinchPageY;
		let origPy = NP.divide( py, settings.zoomValue );
		if( pinchDistance > pinchStartDistance ) {
			mainView.ZoomIn();
		} else if( pinchDistance < pinchStartDistance ) {
			mainView.ZoomOut();
		}
		pinchStartDistance = pinchDistance;

		if( py > cy ) {
			pinchPageY = NP.times( origPy, settings.zoomValue );
			iframe.contentWindow.scroll( { top: NP.minus( pinchPageY, cy ), behavior: "auto", } );
		}
		
		touchMoving = 0;
	}, { passive: false });
}


// https://github.com/obsidianmd/obsidian-api/blob/bceb489fc25ceba5973119d6e57759d64850f90d/obsidian.d.ts#LL1555C18-L1555C25
class Hotkey {
	// https://github.com/obsidianmd/obsidian-api/blob/bceb489fc25ceba5973119d6e57759d64850f90d/obsidian.d.ts#L2498
	public modifiers: Modifier[];
	public key: string;
}

const desktopAppAddr: string = "app://obsidian.md/index.html#";

// const HIGHLIGHT_CLASS_NAME: string = 'obsidian-search-match-highlight';
const HIGHLIGHT_CLASS_NAME: string = 'obsidian-search-match-mark'; // block mark for across elements
const MARK_CLASS_NAME: string = 'obsidian-search-match-mark'; // block mark for across elements

const MAINVIEW_HTML: string = `
<div class="document-search-container" style="display: none; border: none; width: 100%" width="100%" id="ohpMainView">
  <div class="document-search">
    <input class="document-search-input" type="search" placeholder="${i18next.t("editor.search.placeholder-find")}" id="ohpSearchInput">
    <div class="document-search-buttons">
      <button class="document-search-button" aria-label="${i18next.t("editor.search.label-previous")} ${isAppleSys ? "⇧F3" : "Shift + F3"}" aria-label-position="top" id="ohpSearchPrev"></button>
      <button class="document-search-button" aria-label="${i18next.t("editor.search.label-next")} F3" aria-label-position="top" id="ohpSearchNext"></button>
      <button class="document-search-button" aria-label="${i18next.t("editor.search.label-find-all")} ${isAppleSys ? "⌥Enter" : "Alt + Enter"}" aria-label-position="top" id="ohpSearchSelectAll"></button>
	  <span class="document-search-close-button" aria-label="${i18next.t("editor.search.label-exit-search")}" aria-label-position="top" id="ohpSearchExit"></span>
    </div>
  </div>
</div>

<iframe style="border: none; flex-grow: 1; width: 100%; overflow-x: hidden;" loading="eager" margin="0" padding="0"  width="100%" height="100%" id="ohpIframe">
</iframe>
`;

const HIGHLIGHT_STYLE: string = `

  span.obsidian-search-match-highlight {
    box-shadow: 0 0 0px 3px hsl(254, 80%, 68%);
    mix-blend-mode: darken;
	border-radius: 2px;
  }
  span.obsidian-search-match-mark {
    background-color: mark;
    color: marktext;
	border-radius: 2px;
  }

`;

