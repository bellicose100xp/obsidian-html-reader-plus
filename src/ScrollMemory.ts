import { App } from "obsidian";

// Where each HTML file was scrolled to when it was last viewed.
//
// Stored with App.saveLocalStorage, which is Electron's localStorage scoped to this
// vault on this machine. Nothing is written inside the vault folder, so a vault kept in
// git (or synced any other way) never sees these values change and there is nothing to
// ignore or resolve. The trade-off is that positions do not follow the vault to another
// machine; each machine remembers its own.

const STORAGE_KEY = "html-reader-plus:scroll-positions";
const MAX_ENTRIES = 2000;

export interface ScrollEntry {
	// window scroll offset, in the scroll units in effect at the zoom below
	x: number;
	y: number;
	zoom: number;
	// scrollTop of a large nested scroll container, for pages that scroll a wrapper
	// element instead of the document
	inner?: number;
	// last update, epoch ms; used to drop the oldest entries when the store fills up
	t: number;
}

type Store = Record<string, ScrollEntry>;

export class ScrollMemory {
	constructor( private app: App ) {}

	get( path: string ): ScrollEntry | null {
		return this.read()[path] ?? null;
	}

	set( path: string, entry: Omit<ScrollEntry, "t"> ): void {
		const store = this.read();
		const atTop = entry.y === 0 && entry.x === 0 && !entry.inner;
		if( atTop ) {
			if( !(path in store) )
				return;
			delete store[path];
		} else {
			store[path] = { ...entry, t: Date.now() };
			this.prune( store );
		}
		this.write( store );
	}

	remove( path: string ): void {
		const store = this.read();
		if( !(path in store) )
			return;
		delete store[path];
		this.write( store );
	}

	rename( oldPath: string, newPath: string ): void {
		const store = this.read();
		const entry = store[oldPath];
		if( !entry )
			return;
		delete store[oldPath];
		store[newPath] = entry;
		this.write( store );
	}

	private read(): Store {
		const raw = this.app.loadLocalStorage( STORAGE_KEY );
		if( !raw )
			return {};
		if( typeof raw === "object" )
			return raw as Store;
		try {
			const parsed = JSON.parse( raw );
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}

	private write( store: Store ): void {
		this.app.saveLocalStorage( STORAGE_KEY, Object.keys( store ).length ? store : null );
	}

	private prune( store: Store ): void {
		const paths = Object.keys( store );
		if( paths.length <= MAX_ENTRIES )
			return;
		paths.sort( (a, b) => store[a].t - store[b].t );
		for( const path of paths.slice( 0, paths.length - MAX_ENTRIES ) )
			delete store[path];
	}
}

// The nested element that scrolls, for pages laid out with a fixed-height wrapper. Null
// when the document itself scrolls or nothing in the page does.
export function findInnerScrollContainer( doc: Document ): Element | null {
	const root = doc.scrollingElement || doc.documentElement;
	if( root && root.scrollHeight > root.clientHeight + 1 )
		return null;
	const view = doc.defaultView;
	if( !view || !doc.body )
		return null;

	let best: Element | null = null;
	let bestArea = 0;
	for( const el of Array.from( doc.body.querySelectorAll( "*" ) ) ) {
		if( el.scrollHeight <= el.clientHeight + 1 )
			continue;
		const overflowY = view.getComputedStyle( el ).overflowY;
		if( overflowY !== "auto" && overflowY !== "scroll" && overflowY !== "overlay" )
			continue;
		const area = el.clientWidth * el.clientHeight;
		if( area > bestArea ) {
			best = el;
			bestArea = area;
		}
	}
	return best;
}

// Read the current position out of a rendered page.
export function captureScroll( win: Window, zoom: number ): Omit<ScrollEntry, "t"> {
	const entry: Omit<ScrollEntry, "t"> = { x: win.scrollX, y: win.scrollY, zoom };
	const inner = findInnerScrollContainer( win.document );
	if( inner && inner.scrollTop > 0 )
		entry.inner = inner.scrollTop;
	return entry;
}

// Put a saved position back. Zoom is a transform: scale() on <html>, so the window's
// scroll extent scales with it while a nested container's scrollTop does not.
export function applyScroll( win: Window, entry: ScrollEntry, zoom: number ): void {
	const ratio = entry.zoom > 0 ? zoom / entry.zoom : 1;
	win.scrollTo( entry.x * ratio, entry.y * ratio );
	if( entry.inner ) {
		const inner = findInnerScrollContainer( win.document );
		if( inner )
			inner.scrollTop = entry.inner;
	}
}
