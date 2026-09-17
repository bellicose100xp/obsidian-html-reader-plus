import { App } from "obsidian";

// Vim-style normal-mode navigation for rendered HTML files.
//
// An HTML view has no CodeMirror instance, so obsidian-vimrc-support cannot reach it. This
// module reimplements the read-only half of Vim against the rendered document: scrolling
// motions, search, and mappings that run Obsidian commands. It reads the same .vimrc file
// vimrc-support loads so one config drives both Markdown and HTML views.
//
// Supported from the vimrc:
//   exmap <name> obcommand <command-id>
//   map / noremap / nmap / nnoremap <lhs> <rhs>   where <rhs> is either
//       :<exmap-name><CR>  or  :obcommand <command-id><CR>   (runs an Obsidian command)
//       a chain of built-in motions with optional counts, e.g. 10jzz or ^
//   unmap / nunmap <lhs>
//   let mapleader = "<key>"   and <leader> in mappings
//   source <path>
//   " html: <any of the above>     applies here only; a comment to vimrc-support
// Mappings whose right-hand side needs a cursor or edits text are skipped, since there is
// nothing for them to act on in a rendered page.

type Token = string;

// Everything a key action may need. Built from the live iframe when a file loads.
interface NavContext {
	win: Window;
	doc: Document;
	zoom: () => number;
	openSearch: () => void;
	findNext: () => void;
	findPrev: () => void;
	executeCommand: (id: string) => void;
}

type Action = (ctx: NavContext, count: number | null) => void;

// Map and unmap lines in file order, since "nunmap s" followed by "map s ..." must end
// with s mapped.
type MapOp = { kind: "map"; lhs: Token[]; rhs: Token[] } | { kind: "unmap"; lhs: Token[] };

export interface VimrcConfig {
	exmaps: Map<string, string>;
	ops: MapOp[];
	stamp: string;
}

const EMPTY_CONFIG: VimrcConfig = { exmaps: new Map(), ops: [], stamp: "" };

// How often, at most, a keystroke may trigger a check for vimrc edits.
const VIMRC_RECHECK_MS = 2000;

// Vim's default timeoutlen: how long to wait for the rest of a multi-key sequence.
const SEQUENCE_TIMEOUT_MS = 1000;

const SEQ_SEP = "\u0000";
const seqKey = (tokens: Token[]) => tokens.join( SEQ_SEP );

// ---------------------------------------------------------------------------------------
// Reading the vimrc

export async function loadVimrcConfig( app: App ): Promise<VimrcConfig> {
	const fileName = await resolveVimrcFileName( app );
	const config: VimrcConfig = { exmaps: new Map(), ops: [], stamp: await vimrcStamp( app, fileName ) };
	const seen = new Set<string>();
	await sourceInto( app, fileName, config, seen, { leader: "\\" } );
	return config;
}

// Identity of the vimrc on disk, so an open view can notice an edit and rebuild its keys
// without waiting for the file to be reopened.
export async function vimrcStamp( app: App, fileName?: string ): Promise<string> {
	const name = fileName ?? await resolveVimrcFileName( app );
	try {
		const st = await app.vault.adapter.stat( name );
		return st ? `${name}@${st.mtime}:${st.size}` : `${name}@missing`;
	} catch {
		return `${name}@unreadable`;
	}
}

async function resolveVimrcFileName( app: App ): Promise<string> {
	const appAny = app as any;
	const live = appAny.plugins?.plugins?.["obsidian-vimrc-support"]?.settings?.vimrcFileName;
	if( typeof live === "string" && live.trim() )
		return live.trim();

	try {
		const dataPath = `${app.vault.configDir}/plugins/obsidian-vimrc-support/data.json`;
		if( await app.vault.adapter.exists( dataPath ) ) {
			const data = JSON.parse( await app.vault.adapter.read( dataPath ) );
			if( typeof data?.vimrcFileName === "string" && data.vimrcFileName.trim() )
				return data.vimrcFileName.trim();
		}
	} catch {
		// fall through to the default name
	}
	return ".obsidian.vimrc";
}

async function sourceInto( app: App, path: string, config: VimrcConfig, seen: Set<string>, state: { leader: string } ) {
	if( seen.has( path ) )
		return;
	seen.add( path );

	let text: string;
	try {
		if( !(await app.vault.adapter.exists( path )) )
			return;
		text = await app.vault.adapter.read( path );
	} catch {
		return;
	}

	for( const rawLine of text.split( /\r?\n/ ) ) {
		let line = rawLine.trim();
		// a comment of the form  " html: nnoremap J <C-d>  is a directive meant only for
		// rendered HTML files; vimrc-support and the Markdown editor never see it
		const htmlOnly = line.match( /^"\s*html:\s*(.+)$/i );
		if( htmlOnly )
			line = htmlOnly[1].trim();
		if( !line || line.startsWith( '"' ) )
			continue;

		const parts = line.split( /\s+/ );
		const cmd = parts[0];

		if( cmd === "source" && parts[1] ) {
			await sourceInto( app, parts[1], config, seen, state );
			continue;
		}

		const leaderMatch = line.match( /^let\s+(?:g:)?mapleader\s*=\s*(.+)$/ );
		if( leaderMatch ) {
			state.leader = parseLeader( leaderMatch[1] );
			continue;
		}

		if( cmd === "exmap" && parts.length >= 4 && parts[2] === "obcommand" ) {
			config.exmaps.set( parts[1], parts.slice( 3 ).join( " " ) );
			continue;
		}

		const expandLeader = ( s: string ) => s.replace( /<leader>/gi, state.leader );

		if( /^(map|noremap|nmap|nnoremap)$/.test( cmd ) && parts.length >= 3 ) {
			// the right-hand side runs to the end of the line, so ":obcommand some:id<CR>" keeps
			// its space
			const lhs = tokenize( expandLeader( parts[1] ) );
			const rhs = tokenize( expandLeader( parts.slice( 2 ).join( " " ) ) );
			if( lhs && rhs )
				config.ops.push( { kind: "map", lhs, rhs } );
			continue;
		}

		if( /^(unmap|nunmap)$/.test( cmd ) && parts.length >= 2 ) {
			const lhs = tokenize( expandLeader( parts[1] ) );
			if( lhs )
				config.ops.push( { kind: "unmap", lhs } );
			continue;
		}
	}
}

function parseLeader( raw: string ): string {
	let value = raw.trim();
	const quoted = value.match( /^(['"])(.*)\1$/ );
	if( quoted )
		value = quoted[2];
	// "\<Space>" inside double quotes is how Vim spells a special key
	value = value.replace( /^\\</, "<" );
	return value === " " ? "<Space>" : value;
}

// ---------------------------------------------------------------------------------------
// Key notation

// Turn Vim key notation into tokens: one per key, special keys in canonical <...> form.
// Returns null when the notation names a key this engine does not know (<M-j>, <F5>, ...),
// so the caller drops the mapping instead of matching the angle brackets literally.
export function tokenize( notation: string ): Token[] | null {
	const out: Token[] = [];
	let i = 0;
	while( i < notation.length ) {
		if( notation[i] === "<" ) {
			const end = notation.indexOf( ">", i + 1 );
			if( end > i + 1 ) {
				const special = normalizeSpecial( notation.slice( i + 1, end ) );
				if( !special )
					return null;
				out.push( special );
				i = end + 1;
				continue;
			}
		}
		out.push( notation[i] );
		i++;
	}
	return out;
}

function normalizeSpecial( name: string ): Token | null {
	const lower = name.toLowerCase();
	switch( lower ) {
		case "space": return "<Space>";
		case "cr": case "enter": case "return": return "<CR>";
		case "esc": return "<Esc>";
		case "tab": return "<Tab>";
		case "bs": return "<BS>";
		case "lt": return "<";
		case "gt": return ">";
		case "bar": return "|";
		case "bslash": return "\\";
	}
	const ctrl = lower.match( /^c-(.)$/ );
	if( ctrl )
		return `<C-${ctrl[1]}>`;
	const shift = name.match( /^[sS]-(.)$/ );
	if( shift )
		return shift[1].toUpperCase();
	return null;
}

function eventToToken( evt: KeyboardEvent ): Token | null {
	if( evt.metaKey || evt.altKey )
		return null;
	const key = evt.key;
	switch( key ) {
		case "Control": case "Shift": case "Alt": case "Meta":
		case "CapsLock": case "Fn": case "Dead": case "Unidentified":
			return null;
	}
	if( evt.ctrlKey )
		return key.length === 1 ? `<C-${key.toLowerCase()}>` : null;
	switch( key ) {
		case " ": return "<Space>";
		case "Enter": return "<CR>";
		case "Escape": return "<Esc>";
		case "Tab": return "<Tab>";
		case "Backspace": return "<BS>";
	}
	return key.length === 1 ? key : null;
}

// ---------------------------------------------------------------------------------------
// Scrolling

// The element that actually scrolls. Usually the document, but pages that lay themselves
// out with a fixed-height wrapper scroll a nested element instead, so fall back to the
// largest scrollable element in the page.
class ScrollTarget {
	private cached: Element | null = null;
	// when the last full walk found nothing, skip re-walking the DOM for a moment
	private noneUntil = 0;

	constructor( private ctx: NavContext ) {}

	private resolve(): Element | null {
		const doc = this.ctx.doc;
		const root = doc.scrollingElement || doc.documentElement;
		if( root && root.scrollHeight > root.clientHeight + 1 )
			return null; // the window scrolls

		if( this.cached && this.cached.isConnected && this.cached.scrollHeight > this.cached.clientHeight + 1 )
			return this.cached;
		if( Date.now() < this.noneUntil )
			return null;

		let best: Element | null = null;
		let bestArea = 0;
		const view = doc.defaultView;
		if( !view || !doc.body )
			return null;
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
		this.cached = best;
		if( !best )
			this.noneUntil = Date.now() + 1000;
		return best;
	}

	// One line in scroll units. Zoom is a transform: scale() on <html>, which stretches the
	// window's scroll extent but leaves a nested element's scrollBy in layout pixels.
	lineHeight(): number {
		const px = cssLineHeight( this.ctx.doc );
		return this.resolve() ? px : px * this.ctx.zoom();
	}

	viewportHeight(): number {
		const el = this.resolve();
		return el ? el.clientHeight : this.ctx.win.innerHeight;
	}

	by( dx: number, dy: number ) {
		const el = this.resolve();
		( el ?? this.ctx.win ).scrollBy( { left: dx, top: dy, behavior: "auto" } );
	}

	to( opts: { top?: number; left?: number } ) {
		const el = this.resolve();
		( el ?? this.ctx.win ).scrollTo( { ...opts, behavior: "auto" } );
	}

	maxTop(): number {
		const el = this.resolve();
		if( el )
			return el.scrollHeight;
		const root = this.ctx.doc.scrollingElement || this.ctx.doc.documentElement;
		return root ? root.scrollHeight : Number.MAX_SAFE_INTEGER;
	}

	maxLeft(): number {
		const el = this.resolve();
		if( el )
			return el.scrollWidth;
		const root = this.ctx.doc.scrollingElement || this.ctx.doc.documentElement;
		return root ? root.scrollWidth : Number.MAX_SAFE_INTEGER;
	}
}

function cssLineHeight( doc: Document ): number {
	const view = doc.defaultView;
	const body = doc.body;
	let px = NaN;
	if( view && body ) {
		const style = view.getComputedStyle( body );
		px = parseFloat( style.lineHeight );
		if( isNaN( px ) ) {
			const fontSize = parseFloat( style.fontSize );
			if( !isNaN( fontSize ) )
				px = fontSize * 1.4;
		}
	}
	if( isNaN( px ) || px <= 0 )
		px = 24;
	return px;
}

// ---------------------------------------------------------------------------------------
// Built-in actions

function buildBuiltins(): Map<string, Action> {
	const scroller = new WeakMap<NavContext, ScrollTarget>();
	const target = ( ctx: NavContext ) => {
		let t = scroller.get( ctx );
		if( !t ) {
			t = new ScrollTarget( ctx );
			scroller.set( ctx, t );
		}
		return t;
	};
	const n = ( count: number | null ) => count ?? 1;

	const lines = ( dir: 1 | -1 ): Action => ( ctx, count ) => { const t = target( ctx ); t.by( 0, dir * n( count ) * t.lineHeight() ); };
	const cols = ( dir: 1 | -1 ): Action => ( ctx, count ) => { const t = target( ctx ); t.by( dir * n( count ) * t.lineHeight(), 0 ); };
	const pages = ( fraction: number ): Action => ( ctx, count ) => { const t = target( ctx ); t.by( 0, fraction * n( count ) * t.viewportHeight() ); };
	const noop: Action = () => {};

	const b = new Map<string, Action>();
	const set = ( notation: string, action: Action ) => b.set( seqKey( tokenize( notation )! ), action );

	set( "j", lines( 1 ) );
	set( "k", lines( -1 ) );
	set( "<C-e>", lines( 1 ) );
	set( "<C-y>", lines( -1 ) );
	set( "h", cols( -1 ) );
	set( "l", cols( 1 ) );
	set( "<C-d>", pages( 0.5 ) );
	set( "<C-u>", pages( -0.5 ) );
	// no cursor to join lines or look up help with, so the shifted pair scrolls half a page
	set( "J", pages( 0.5 ) );
	set( "K", pages( -0.5 ) );
	set( "<C-f>", pages( 1 ) );
	set( "<C-b>", pages( -1 ) );
	set( "gg", ( ctx ) => target( ctx ).to( { top: 0 } ) );
	set( "G", ( ctx ) => target( ctx ).to( { top: target( ctx ).maxTop() } ) );
	set( "0", ( ctx ) => target( ctx ).to( { left: 0 } ) );
	set( "^", ( ctx ) => target( ctx ).to( { left: 0 } ) );
	set( "$", ( ctx ) => target( ctx ).to( { left: target( ctx ).maxLeft() } ) );
	set( "zz", noop );
	set( "zt", noop );
	set( "zb", noop );
	set( "/", ( ctx ) => ctx.openSearch() );
	set( "n", ( ctx, count ) => { for( let i = 0; i < n( count ); i++ ) ctx.findNext(); } );
	set( "N", ( ctx, count ) => { for( let i = 0; i < n( count ); i++ ) ctx.findPrev(); } );
	return b;
}

// Longest built-in sequence, so RHS chains like "10jzz" can be split without a tokenizer
// that knows every command.
const MAX_BUILTIN_LEN = 2;

// Compile a mapping's right-hand side into one action, or null when it uses something a
// rendered page cannot do (text edits, marks, registers, cursor motions).
function compileRhs( rhs: Token[], exmaps: Map<string, string>, builtins: Map<string, Action> ): Action | null {
	if( rhs.length === 0 )
		return null;

	if( rhs[0] === ":" ) {
		const end = rhs.indexOf( "<CR>" );
		if( end < 0 )
			return null;
		const cmdline = rhs.slice( 1, end ).map( t => t === "<Space>" ? " " : t ).join( "" ).trim();
		const [name, ...rest] = cmdline.split( /\s+/ );
		let commandId: string | undefined;
		if( name === "obcommand" && rest.length > 0 )
			commandId = rest.join( " " );
		else
			commandId = exmaps.get( name );
		if( !commandId )
			return null;
		const id = commandId;
		return ( ctx ) => ctx.executeCommand( id );
	}

	const steps: { action: Action; count: number | null }[] = [];
	let i = 0;
	while( i < rhs.length ) {
		let digits = "";
		while( i < rhs.length && /^[0-9]$/.test( rhs[i] ) && ( digits !== "" || rhs[i] !== "0" ) ) {
			digits += rhs[i];
			i++;
		}
		let matched: Action | undefined;
		let matchedLen = 0;
		for( let len = Math.min( MAX_BUILTIN_LEN, rhs.length - i ); len >= 1; len-- ) {
			const candidate = builtins.get( seqKey( rhs.slice( i, i + len ) ) );
			if( candidate ) {
				matched = candidate;
				matchedLen = len;
				break;
			}
		}
		if( !matched )
			return null;
		steps.push( { action: matched, count: digits ? parseInt( digits, 10 ) : null } );
		i += matchedLen;
	}
	if( steps.length === 0 )
		return null;

	return ( ctx, outerCount ) => {
		for( const step of steps ) {
			let count = step.count;
			if( outerCount !== null )
				count = count === null ? outerCount : count * outerCount;
			step.action( ctx, count );
		}
	};
}

// The key table for one view: built-ins with the vimrc's mappings applied in file order.
export function buildKeyTable( config: VimrcConfig ): Map<string, Action> {
	const builtins = buildBuiltins();
	const table = new Map( builtins );
	for( const op of config.ops ) {
		if( op.kind === "unmap" ) {
			table.delete( seqKey( op.lhs ) );
			continue;
		}
		const action = compileRhs( op.rhs, config.exmaps, builtins );
		if( action )
			table.set( seqKey( op.lhs ), action );
	}
	return table;
}

// ---------------------------------------------------------------------------------------
// The key engine

export class KeyEngine {
	private pending: Token[] = [];
	private count = "";
	private timer: number | null = null;
	// exact match waiting to see whether the next key extends it into a longer mapping
	private armedExact: Action | null = null;

	constructor( private table: Map<string, Action>, private ctx: NavContext ) {}

	setTable( table: Map<string, Action> ) {
		this.table = table;
		this.reset();
	}

	// Returns true when the key was consumed and the browser default should be suppressed.
	feed( token: Token ): boolean {
		if( token === "<Esc>" ) {
			this.reset();
			return false;
		}

		if( this.pending.length === 0 && /^[0-9]$/.test( token ) && ( this.count !== "" || token !== "0" ) ) {
			this.count += token;
			this.arm( () => this.reset() );
			return true;
		}

		this.pending.push( token );
		const key = seqKey( this.pending );
		const exact = this.table.get( key );
		const hasLonger = this.hasLongerCandidate( key );

		if( exact && !hasLonger ) {
			this.run( exact );
			return true;
		}
		if( exact ) {
			// ambiguous: wait for more keys, run this one if none come
			this.armedExact = exact;
			this.arm( () => this.run( exact ) );
			return true;
		}
		if( hasLonger ) {
			this.arm( () => this.reset() );
			return true;
		}

		// no mapping starts with this sequence. Like Vim, run the shorter mapping that was
		// waiting (if any), then retry with just the last key so a stray prefix does not
		// swallow the next command.
		const retry = this.pending.length > 1;
		const waiting = this.armedExact;
		this.reset();
		if( waiting )
			this.run( waiting );
		return retry ? this.feed( token ) : false;
	}

	private hasLongerCandidate( key: string ): boolean {
		const prefix = key + SEQ_SEP;
		for( const k of this.table.keys() )
			if( k.startsWith( prefix ) )
				return true;
		return false;
	}

	private run( action: Action ) {
		const count = this.count ? parseInt( this.count, 10 ) : null;
		this.reset();
		try {
			action( this.ctx, count );
		} catch( err ) {
			console.error( "HTML Reader Plus: vim navigation action failed", err );
		}
	}

	private arm( fn: () => void ) {
		this.disarm();
		this.timer = window.setTimeout( () => {
			this.timer = null;
			fn();
		}, SEQUENCE_TIMEOUT_MS );
	}

	private disarm() {
		if( this.timer !== null ) {
			window.clearTimeout( this.timer );
			this.timer = null;
		}
	}

	reset() {
		this.disarm();
		this.pending = [];
		this.count = "";
		this.armedExact = null;
	}
}

function isEditableTarget( target: EventTarget | null ): boolean {
	const el = target as HTMLElement | null;
	if( !el || typeof el.tagName !== "string" )
		return false;
	return !!el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test( el.tagName );
}

// Buttons, links, and anything else the page made focusable activate on Space or Enter.
// Those two keys stay with the page while such an element has focus; j, k and the rest
// still navigate.
function isActivatableTarget( target: EventTarget | null ): boolean {
	const el = target as HTMLElement | null;
	if( !el || typeof el.tagName !== "string" || el === el.ownerDocument?.body )
		return false;
	if( /^(BUTTON|A|SUMMARY|OPTION)$/.test( el.tagName ) )
		return true;
	if( el.hasAttribute( "role" ) )
		return true;
	const tabindex = el.getAttribute( "tabindex" );
	return tabindex !== null && parseInt( tabindex, 10 ) >= 0;
}

export interface VimNavigationHost {
	app: App;
	iframe: HTMLIFrameElement;
	containerEl: HTMLElement;     // the view's host-realm container
	isActive: () => boolean;      // is this view the workspace's active leaf
	zoom: () => number;
	openSearch: () => void;
	findNext: () => void;
	findPrev: () => void;
}

// Wire the engine to a freshly loaded iframe. Returns a disposer for the host-side listener;
// the iframe-side listener dies with the iframe document.
export function installVimNavigation( host: VimNavigationHost, config: VimrcConfig = EMPTY_CONFIG ): () => void {
	const frameWin = host.iframe.contentWindow;
	const frameDoc = host.iframe.contentDocument;
	if( !frameWin || !frameDoc )
		return () => {};

	const appAny = host.app as any;
	const ctx: NavContext = {
		win: frameWin,
		doc: frameDoc,
		zoom: host.zoom,
		openSearch: host.openSearch,
		findNext: host.findNext,
		findPrev: host.findPrev,
		executeCommand: ( id ) => { appAny.commands?.executeCommandById?.( id ); },
	};
	const engine = new KeyEngine( buildKeyTable( config ), ctx );

	// Pick up vimrc edits while the file stays open. Stat is async, so the swap lands on the
	// next keystroke after the change is noticed.
	let stamp = config.stamp;
	let lastCheck = 0;
	let checking = false;
	const maybeReloadConfig = () => {
		const now = Date.now();
		if( checking || now - lastCheck < VIMRC_RECHECK_MS )
			return;
		lastCheck = now;
		checking = true;
		vimrcStamp( host.app ).then( async ( current ) => {
			if( current === stamp )
				return;
			const fresh = await loadVimrcConfig( host.app );
			stamp = fresh.stamp;
			engine.setTable( buildKeyTable( fresh ) );
		} ).catch( () => {} ).finally( () => { checking = false; } );
	};

	const handle = ( evt: KeyboardEvent ) => {
		if( evt.defaultPrevented )
			return;
		maybeReloadConfig();
		if( isEditableTarget( evt.target ) ) {
			engine.reset();
			return;
		}
		const token = eventToToken( evt );
		if( !token )
			return;
		if( ( token === "<Space>" || token === "<CR>" ) && isActivatableTarget( evt.target ) ) {
			engine.reset();
			return;
		}
		if( engine.feed( token ) )
			evt.preventDefault();
	};

	// Bubble phase, so a page's own shortcuts get first refusal via preventDefault().
	// forwardHotkeysToObsidian() makes keyboard events unstoppable in this realm, so the
	// event always reaches the window.
	frameWin.addEventListener( "keydown", handle, false );

	// Keys typed while focus is outside the iframe but this view is still the active leaf.
	// Closing a modal (quick switcher, Esc or a click on the backdrop) leaves focus on the
	// document body or on the leaf's chrome, neither of which is inside the iframe, so a
	// listener on the container alone would go deaf until the user clicks the page again.
	// Listen on the document and accept keys whose target is the body, inside this view, or
	// one of its ancestors. Iframe keydowns are re-dispatched on the iframe element itself;
	// those were already handled inside the frame.
	const hostDoc = host.containerEl.ownerDocument;
	const hostHandle = ( evt: KeyboardEvent ) => {
		const target = evt.target as Node | null;
		if( !target || target === host.iframe || !host.isActive() )
			return;
		const inScope = target === hostDoc.body
			|| host.containerEl.contains( target )
			|| ( target.nodeType === Node.ELEMENT_NODE && target.contains( host.containerEl ) );
		if( !inScope || isEditableTarget( target ) )
			return;
		// send focus back into the page first, so the rest of the sequence arrives through
		// the iframe path; if the key opens a modal, that modal takes focus afterwards
		frameWin.focus();
		handle( evt );
	};
	hostDoc.addEventListener( "keydown", hostHandle, false );
	return () => {
		hostDoc.removeEventListener( "keydown", hostHandle, false );
		engine.reset(); // drop any armed timer so it cannot fire against a view that is gone
	};
}
