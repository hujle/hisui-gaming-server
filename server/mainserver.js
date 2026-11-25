const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const url = require('url');
const MClient = require("../client/mclient");
const LogHelper = require("../loghelper");
const MData = require('../multplayerdata/mdata');
const GameServer = require('./gameserver');
const conf = require('../conf/conf');

const MIME_TYPES = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.mjs': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
	'.txt': 'text/plain',
	'.xml': 'application/xml'
};

const DEFAULT_MIME = 'application/octet-stream';

class MainServer {
	gameservers;
	#clients;
	#host;
	mdata;
	#frontendPath;
	#gameNames;
	constructor (hostArgs) {
		this.#clients = {};
		this.gameservers = {};
		this.mdata = new MData();
		this.#frontendPath = this.#resolveFrontendPath(hostArgs);
		this.#gameNames = new Set();
		this.#refreshGameList();

		if(hostArgs.https)
		{
			const cert = fs.readFileSync(hostArgs.https.certpath);
			const key = fs.readFileSync(hostArgs.https.keypath);
			const httpsServer = https.createServer({cert, key}, (req, res)=>this.onHttpRequest(req, res)).listen(hostArgs.port);
			this.#host = new WebSocket.Server({server: httpsServer});
		}
		else
		{
			const httpServer = http.createServer((req, res)=>this.onHttpRequest(req, res)).listen(hostArgs.port);
			this.#host = new WebSocket.Server({server: httpServer});
		}
		this.#host.on('connection', (client, request)=>this.onConnect(client, request));
		LogHelper.log(`Running server at port ${hostArgs.port}`)
		LogHelper.log(`Serving frontend from ${this.#frontendPath}`)
	}

	#resolveFrontendPath(hostArgs) {
		if (hostArgs.frontendPath) {
			return path.resolve(hostArgs.frontendPath);
		}
		return path.resolve(__dirname, '../../frontend');
	}

	#refreshGameList() {
		const gamesDir = path.join(this.#frontendPath, 'games');
		const names = new Set();
		try {
			if (fs.existsSync(gamesDir)) {
				for (const entry of fs.readdirSync(gamesDir, { withFileTypes: true })) {
					if (entry.isDirectory()) {
						names.add(entry.name);
					}
				}
			}
		} catch (e) {
			LogHelper.warn(`Could not read games directory: ${e.message}`);
		}
		this.#gameNames = names;
	}

	#isValidGame(name) {
		if (!name) return false;
		// Re-scan on cache miss so newly added games are picked up dynamically.
		if (!this.#gameNames.has(name)) {
			this.#refreshGameList();
		}
		return this.#gameNames.has(name);
	}

	#getMimeType(filePath) {
		const ext = path.extname(filePath).toLowerCase();
		return MIME_TYPES[ext] || DEFAULT_MIME;
	}

	#sendFile(res, filePath, statusCode = 200) {
		fs.readFile(filePath, (err, data) => {
			if (err) {
				LogHelper.warn(`Failed to read ${filePath}: ${err.message}`);
				res.writeHead(404, {'Content-Type': 'text/plain'});
				res.end('Not found');
				return;
			}
			res.writeHead(statusCode, {
				'Content-Type': this.#getMimeType(filePath),
				'Access-Control-Allow-Origin': '*'
			});
			res.end(data);
		});
	}

	#sendForbidden(res) {
		res.writeHead(403, {'Content-Type': 'text/plain'});
		res.end('Forbidden');
	}

	#serveStatic(req, res, pathname) {
		// Strip leading slash and normalize to prevent traversal.
		const relative = pathname.replace(/^\/+/, '');
		if (!relative) {
			this.#sendFile(res, path.join(this.#frontendPath, 'index.html'));
			return;
		}
		const safeRelative = relative.split('/').filter(p => p && p !== '.' && p !== '..').join('/');
		if (!safeRelative || relative.includes('..')) {
			this.#sendForbidden(res);
			return;
		}
		const filePath = path.join(this.#frontendPath, safeRelative);
		// Ensure the resolved path stays inside the frontend directory.
		if (!filePath.startsWith(this.#frontendPath + path.sep) && filePath !== this.#frontendPath) {
			LogHelper.warn(`Traversal blocked: ${filePath}`);
			this.#sendForbidden(res);
			return;
		}
		fs.stat(filePath, (err, stats) => {
			if (err) {
				LogHelper.warn(`Static stat error for ${filePath}: ${err.message}`);
				res.writeHead(404, {'Content-Type': 'text/plain'});
				res.end('Not found');
				return;
			}
			if (!stats.isFile()) {
				LogHelper.warn(`Static not a file: ${filePath}`);
				res.writeHead(404, {'Content-Type': 'text/plain'});
				res.end('Not found');
				return;
			}
			this.#sendFile(res, filePath);
		});
	}

	getGameServer(name) {
		if(!this.gameservers[name])
			this.gameservers[name] = new GameServer(name, this);

		return this.gameservers[name];
	}

	getTotalPlayers() {
		let count = 0;
		for(let name in this.gameservers) {
			count += this.gameservers[name].clientsCount;
		}
		return count;
	}

	getGamePlayerCounts() {
		let counts = {};
		for(let name in this.gameservers) {
			counts[name] = this.gameservers[name].clientsCount;
		}
		return counts;
	}

	onHttpRequest(req, res) {
		let parsedUrl;
		try {
			parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
		} catch(e) {
			parsedUrl = url.parse(req.url, true);
		}
		const pathname = parsedUrl.pathname;

		// API endpoint for player counts must remain available.
		if(pathname === '/api/players') {
			const game = parsedUrl.searchParams.get('game');
			let response = {
				total: this.getTotalPlayers()
			};
			if(game) {
				const gs = this.gameservers[game];
				response.game = game;
				response.count = gs ? gs.clientsCount : 0;
			} else {
				response.games = this.getGamePlayerCounts();
			}
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*'
			});
			res.end(JSON.stringify(response));
			return;
		}

		// Root game picker page.
		if (pathname === '/' || pathname === '/index.html') {
			this.#sendFile(res, path.join(this.#frontendPath, 'index.html'));
			return;
		}

		// If the request looks like a file (has an extension), serve it statically.
		// This covers /easyrpg-player.html, .js/.css/.wasm, and game resources.
		if (path.extname(pathname)) {
			this.#serveStatic(req, res, pathname);
			return;
		}

		// Dedicated game page: /<game>/ or /<game>
		const gameMatch = pathname.match(/^\/([^/]+)\/?$/);
		if (gameMatch) {
			const gameName = decodeURIComponent(gameMatch[1]);
			if (this.#isValidGame(gameName)) {
				this.#sendFile(res, path.join(this.#frontendPath, 'game.html'));
			} else {
				res.writeHead(404, {'Content-Type': 'text/plain'});
				res.end('Game not found');
			}
			return;
		}

		// Everything else is served as a static asset from the frontend folder.
		this.#serveStatic(req, res, pathname);
	}

	onConnect(client, request) {
		let mclient = new MClient(client, request, this);
		this.#clients[client.connectionId] = mclient;
		if(conf.echo) mclient.echoId();
		mclient.sendMDataPackets(this.mdata.getFull());
		client.onmessage = (req)=>this.onMessage(mclient, req);
		client.on('close', ()=>this.onClose(mclient));
	}

	onMessage(client, req) {
		let data = req.data;
		if(typeof data === "string") return;
		let type = data.readUint8(0);
		switch(type) {
			case 0:
			    this.onMapPacket(client, data)
			break;

			case 1:
			    if(client.map)
			        client.map.processPacket(client, data.slice(1));
			break;
			default:
			    
			break;
		}
	}

	onMapPacket(client, data) {
		if(data.length == 3) {
			let mapId = data.readUInt16LE(1);
			if(!client.map || (client.map.id != mapId))
			    client.map = client.game.getMap(mapId);
			else
			    LogHelper.warn("Client tries to join the same map that it is already in");
		}
		else
			LogHelper.warn("Invalid map change packet");
	}

	onClose(client) {
		client.game.disconnectClient(client);
		if(!client.game.clientsCount) delete this.gameservers[client.game.name];
		LogHelper.log(`Client ${client.connectionId} closed connection.`);
	}

	broadcastMData(mdataSlots) {
		for(let c in this.#clients) {
			this.#clients[c].sendMDataPackets(mdataSlots);
		}
	}
}

module.exports = MainServer;